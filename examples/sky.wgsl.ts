/**
 * A WGSL port of RedPewEngine's physically-based sky — the Hillaire 2020 participating-medium
 * atmosphere, as four passes over `bun:ffi`.
 *
 * The engine writes this in Slang (`packages/render2d/shaders/modules/engine/atmosphere.slang` and
 * the three `sky/*.slang` kernels) and compiles it to SPIR-V. What is below is the same math
 * transcribed to WGSL, minus the parts that only mean something inside a renderer: the starfield,
 * aerial perspective, and the camera-relative rebasing. It is here because a binding's example
 * should be something someone actually renders, and because the pass structure — two precompute
 * kernels feeding a per-frame kernel feeding a fullscreen shader — is exactly the shape headless
 * GPU work takes.
 *
 * Kept verbatim from the engine, because they are the reason it looks right rather than merely
 * plausible:
 *
 *   · **`r² − R²` is never evaluated.** At one metre of altitude the true value sits under a 4 km²
 *     ulp of the difference of squares — a 31 % error. `heightAt` / `horizonDistance` expand the
 *     identity instead.
 *   · **The segment integral's `σ_E → 0` branch.** `(S − S·1)/0` is NaN, and an airless preset sets
 *     every coefficient to zero. Not defensive; load-bearing.
 *   · **Two isotropic phase factors in the multiscatter kernel that are not the same one.** The
 *     outer cancels into a plain mean; the inner does not. Getting this wrong is a factor of 4π —
 *     12.6×, a sky that looks fine and is wrong.
 *   · **The horizon-relative quadratic sky-view mapping.** It is what makes 192×108 enough for a
 *     sunset; a linear axis needs thousands of rows and still loses grazing rays to f32.
 *
 * Units are kilometres throughout, so the literature coefficients paste in unchanged.
 */

/** The medium, the geometry, the phase functions and the LUT parameterisations — one copy. */
export const ATMOSPHERE_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const INV_PI: f32 = 0.31830988618;
const ATM_MIN_EXTINCTION: f32 = 1e-9;
const ATM_MAX_LUT_RADIANCE: f32 = 64000.0;

struct Atmosphere {
  rayleighScattering: vec4f,
  mieScattering: vec4f,
  mieExtinction: vec4f,
  ozoneAbsorption: vec4f,
  groundAlbedo: vec4f,
  planetRadius: f32,
  atmosphereRadius: f32,
  rayleighScaleHeight: f32,
  mieScaleHeight: f32,
  ozoneCenter: f32,
  ozoneHalfWidth: f32,
  mieAnisotropy: f32,
  multiScatteringFactor: f32,
}

struct Medium {
  scattering: vec3f,
  extinction: vec3f,
}

// ── geometry: the four identities that keep f32 honest ─────────────────────────────────────────

/// sqrt(r² − R²) for r = R + h, expanded as sqrt(h(2R + h)).
fn horizonDistance(planetRadius: f32, h: f32) -> f32 {
  return sqrt(max(h * (2.0 * planetRadius + h), 0.0));
}

fn topHorizonDistance(planetRadius: f32, atmosphereRadius: f32) -> f32 {
  return horizonDistance(planetRadius, atmosphereRadius - planetRadius);
}

/// Inverse of horizonDistance, written so the answer never comes out of a difference of two large
/// magnitudes.
fn heightFromHorizonDistance(planetRadius: f32, rho: f32) -> f32 {
  let rho2 = rho * rho;
  return rho2 / (sqrt(rho2 + planetRadius * planetRadius) + planetRadius);
}

struct HeightAt {
  h: f32,
  r: f32,
}

/// Altitude (and geocentric radius) at distance t along a ray from altitude h with mu = cos(zenith).
/// The numerator is the EXPANDED r_t² − R², so the ground stays at exactly 0.
fn heightAt(planetRadius: f32, h: f32, mu: f32, t: f32) -> HeightAt {
  let r = planetRadius + h;
  let along = t * t + 2.0 * r * t * mu;
  var out: HeightAt;
  out.r = sqrt(max(along + r * r, 0.0));
  let num = along + h * (2.0 * planetRadius + h);
  out.h = max(num / max(out.r + planetRadius, 1e-6), 0.0);
  return out;
}

/// Farthest positive root of the ray/shell quadratic, in the stable form — computing both roots
/// from −b ± √disc loses the small one to cancellation in exactly the near-tangent case.
fn distanceToTop(r: f32, mu: f32, atmosphereRadius: f32) -> f32 {
  let b = 2.0 * r * mu;
  let c = (r - atmosphereRadius) * (r + atmosphereRadius);
  let disc = b * b - 4.0 * c;
  if (disc <= 0.0) { return 0.0; }
  var s = 1.0;
  if (b < 0.0) { s = -1.0; }
  let q = -0.5 * (b + s * sqrt(disc));
  return max(max(q, c / q), 0.0);
}

/// Nearest non-negative root against a sphere the ray starts outside of, or −1 on a miss. The
/// c <= 0 branch is the on-the-surface case and is not redundant: reading it as a miss lets every
/// downward ray march through the planet at clamped ground density.
fn distanceToSphereFromOutside(r: f32, mu: f32, shellRadius: f32) -> f32 {
  let b = 2.0 * r * mu;
  if (b >= 0.0) { return -1.0; }
  let c = (r - shellRadius) * (r + shellRadius);
  if (c <= 0.0) { return 0.0; }
  let disc = b * b - 4.0 * c;
  if (disc < 0.0) { return -1.0; }
  let q = -0.5 * (b - sqrt(disc));
  return min(q, c / q);
}

fn distanceToGround(r: f32, mu: f32, planetRadius: f32) -> f32 {
  return distanceToSphereFromOutside(r, mu, planetRadius);
}

fn rayHitsGround(r: f32, mu: f32, planetRadius: f32) -> bool {
  return distanceToGround(r, mu, planetRadius) >= 0.0;
}

// ── medium ─────────────────────────────────────────────────────────────────────────────────────

/// (Rayleigh, aerosol, ozone) normalised densities. The first two are exponential; ozone is the
/// standard tent, which is what makes a twilight sky blue instead of brown.
fn densities(a: Atmosphere, h: f32) -> vec3f {
  return vec3f(
    exp(-h / a.rayleighScaleHeight),
    exp(-h / a.mieScaleHeight),
    max(0.0, 1.0 - abs(h - a.ozoneCenter) / a.ozoneHalfWidth),
  );
}

fn sampleMedium(a: Atmosphere, h: f32) -> Medium {
  let d = densities(a, h);
  var m: Medium;
  m.scattering = a.rayleighScattering.rgb * d.x + a.mieScattering.rgb * d.y;
  m.extinction = a.rayleighScattering.rgb * d.x + a.mieExtinction.rgb * d.y + a.ozoneAbsorption.rgb * d.z;
  return m;
}

// ── phase functions ────────────────────────────────────────────────────────────────────────────

fn phaseRayleigh(cosTheta: f32) -> f32 {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

/// Cornette-Shanks: Henyey-Greenstein with the 1 + cos²θ factor restored, which keeps the
/// backscatter lobe from collapsing at high g.
fn phaseCornetteShanks(g: f32, cosTheta: f32) -> f32 {
  let g2 = g * g;
  let k = (3.0 / (8.0 * PI)) * (1.0 - g2) / (2.0 + g2);
  let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
  return k * (1.0 + cosTheta * cosTheta) / (denom * sqrt(denom));
}

fn phaseIsotropic() -> f32 { return 1.0 / (4.0 * PI); }

// ── segment integral ───────────────────────────────────────────────────────────────────────────

/// Analytic in-scattering of one march segment (Hillaire / Frostbite): the source is integrated
/// against the segment's own extinction rather than held constant, which is what lets 32 samples
/// look like hundreds. The degenerate branch is mandatory — with every coefficient zero the closed
/// form is 0/0.
fn segmentIntegral(source: vec3f, extinction: vec3f, segTransmittance: vec3f, ds: f32) -> vec3f {
  let safe = max(extinction, vec3f(ATM_MIN_EXTINCTION));
  let integrated = (source - source * segTransmittance) / safe;
  let degenerate = step(extinction, vec3f(ATM_MIN_EXTINCTION));
  return mix(integrated, source * ds, degenerate);
}

// ── LUT parameterisations ──────────────────────────────────────────────────────────────────────

/// Half-texel inset, so the first and last texel CENTRES land on 0 and 1 and a linear fetch at the
/// edge is not half-extrapolated.
fn unitToTexCoord(x: f32, size: f32) -> f32 { return 0.5 / size + x * (1.0 - 1.0 / size); }
fn texCoordToUnit(u: f32, size: f32) -> f32 { return (u - 0.5 / size) / (1.0 - 1.0 / size); }

/// Bruneton-Neyret transmittance parameterisation: altitude by horizon distance, view by the ray's
/// own distance to the shell between its minimum and maximum. Both axes stay resolved near the
/// horizon, which a naive (h, mu) grid does not.
fn transmittanceUnit(planetRadius: f32, atmosphereRadius: f32, h: f32, mu: f32) -> vec2f {
  let r = planetRadius + h;
  let H = topHorizonDistance(planetRadius, atmosphereRadius);
  let rho = horizonDistance(planetRadius, h);
  let d = distanceToTop(r, mu, atmosphereRadius);
  let dMin = atmosphereRadius - r;
  let dMax = rho + H;
  let xMu = (d - dMin) / max(dMax - dMin, 1e-6);
  return vec2f(saturate(xMu), saturate(rho / max(H, 1e-6)));
}

struct HeightMu { h: f32, mu: f32 }

fn transmittanceParams(planetRadius: f32, atmosphereRadius: f32, unit: vec2f) -> HeightMu {
  let H = topHorizonDistance(planetRadius, atmosphereRadius);
  let rho = H * unit.y;
  var out: HeightMu;
  out.h = heightFromHorizonDistance(planetRadius, rho);
  let r = planetRadius + out.h;
  let dMin = atmosphereRadius - r;
  let dMax = rho + H;
  let d = dMin + unit.x * (dMax - dMin);
  if (d <= 0.0) {
    out.mu = 1.0;
  } else {
    out.mu = clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  }
  return out;
}

fn multiScatterUnit(planetRadius: f32, atmosphereRadius: f32, h: f32, sunCosZenith: f32) -> vec2f {
  let thickness = max(atmosphereRadius - planetRadius, 1e-3);
  return vec2f(saturate(0.5 + 0.5 * sunCosZenith), saturate(h / thickness));
}

fn multiScatterParams(planetRadius: f32, atmosphereRadius: f32, unit: vec2f) -> HeightMu {
  let thickness = max(atmosphereRadius - planetRadius, 1e-3);
  var out: HeightMu;
  out.h = unit.y * thickness;
  out.mu = unit.x * 2.0 - 1.0; // sun cos-zenith
  return out;
}

fn zenithHorizonAngle(planetRadius: f32, h: f32) -> f32 {
  let r = planetRadius + h;
  let cosBeta = clamp(horizonDistance(planetRadius, h) / max(r, 1e-6), 0.0, 1.0);
  return PI - acos(cosBeta);
}

const ATM_SKYVIEW_HINGE_DIP: f32 = 0.10472;

/// Share of the sky-view v axis given to the above-horizon half. Half-and-half is right for an eye
/// on the ground; the band the LUT must resolve widens with the horizon dip, so the hinge slides.
fn skyViewHorizonV(planetRadius: f32, h: f32) -> f32 {
  let dip = acos(clamp(planetRadius / max(planetRadius + h, 1e-6), 0.0, 1.0));
  return 0.5 + 0.25 * saturate(dip / ATM_SKYVIEW_HINGE_DIP);
}

/// v is horizon-relative and quadratic on each side of the hinge; u is quadratic in the
/// sun-relative azimuth cosine, concentrating texels on the solar hemisphere.
fn skyViewUnit(planetRadius: f32, h: f32, viewZenithCos: f32, lightViewCos: f32) -> vec2f {
  let zenithHorizon = zenithHorizonAngle(planetRadius, h);
  let beta = PI - zenithHorizon;
  let vh = skyViewHorizonV(planetRadius, h);
  let viewZenith = acos(clamp(viewZenithCos, -1.0, 1.0));

  var v: f32;
  if (viewZenith < zenithHorizon) {
    let coord = viewZenith / max(zenithHorizon, 1e-6);
    v = vh * (1.0 - sqrt(max(1.0 - coord, 0.0)));
  } else {
    let coord = (viewZenith - zenithHorizon) / max(beta, 1e-6);
    v = vh + (1.0 - vh) * sqrt(saturate(coord));
  }
  let u = sqrt(saturate(0.5 * (1.0 - lightViewCos)));
  return vec2f(u, saturate(v));
}

struct ViewAngles { viewZenithCos: f32, lightViewCos: f32 }

fn skyViewParams(planetRadius: f32, unit: vec2f, h: f32) -> ViewAngles {
  let zenithHorizon = zenithHorizonAngle(planetRadius, h);
  let beta = PI - zenithHorizon;
  let vh = skyViewHorizonV(planetRadius, h);

  var viewZenith: f32;
  if (unit.y < vh) {
    let t = 1.0 - unit.y / max(vh, 1e-6);
    viewZenith = zenithHorizon * (1.0 - t * t);
  } else {
    let t = (unit.y - vh) / max(1.0 - vh, 1e-6);
    viewZenith = zenithHorizon + beta * t * t;
  }
  var out: ViewAngles;
  out.viewZenithCos = cos(viewZenith);
  out.lightViewCos = 1.0 - 2.0 * unit.x * unit.x;
  return out;
}

/// Rebuild a direction in the frame where the sun's azimuth is +X and up is +Y. The Z sign is
/// arbitrary — the atmosphere is rotationally symmetric about the sun-zenith plane, which is
/// precisely why a 2D LUT suffices.
fn skyViewDirection(viewZenithCos: f32, lightViewCos: f32) -> vec3f {
  let sinZenith = sqrt(saturate(1.0 - viewZenithCos * viewZenithCos));
  let sinAzimuth = sqrt(saturate(1.0 - lightViewCos * lightViewCos));
  return vec3f(sinZenith * lightViewCos, viewZenithCos, sinZenith * sinAzimuth);
}

fn lightViewCosAbout(up: vec3f, viewDir: vec3f, sunDir: vec3f) -> f32 {
  let v = viewDir - up * dot(viewDir, up);
  let s = sunDir - up * dot(sunDir, up);
  let lv = length(v);
  let ls = length(s);
  if (lv < 1e-5 || ls < 1e-5) { return 1.0; }
  return clamp(dot(v / lv, s / ls), -1.0, 1.0);
}

// ── sampling patterns ──────────────────────────────────────────────────────────────────────────

/// Van der Corput radical inverse, base 2.
fn radicalInverse(bitsIn: u32) -> f32 {
  var bits = bitsIn;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

/// i-th of n Hammersley directions, uniform over the sphere. Uniform rather than cosine-weighted:
/// the multi-scattering integral assumes an isotropic phase, so every direction weighs the same.
fn sphereDirection(i: u32, n: u32) -> vec3f {
  let u1 = (f32(i) + 0.5) / f32(n);
  let u2 = radicalInverse(i);
  let cosTheta = 1.0 - 2.0 * u1;
  let sinTheta = sqrt(saturate(1.0 - cosTheta * cosTheta));
  let phi = TAU * u2;
  return vec3f(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi));
}

/// t ∝ s² puts samples where the medium is dense instead of spreading them over mostly vacuum.
fn marchT(s: f32, tMax: f32) -> f32 { return tMax * s * s; }

fn saturate(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

/// Manual bilinear fetch. A compute pipeline carries no sampler here, so the kernels that read an
/// upstream LUT filter it by hand; the fragment shader, which does have one, samples instead.
fn fetchBilinear(tex: texture_2d<f32>, uv: vec2f, size: vec2f) -> vec3f {
  let st = uv * size - 0.5;
  let base = floor(st);
  let f = st - base;
  let lo = clamp(base, vec2f(0.0), size - 1.0);
  let hi = clamp(base + 1.0, vec2f(0.0), size - 1.0);
  let i0 = vec2i(lo);
  let i1 = vec2i(hi);
  let c00 = textureLoad(tex, vec2i(i0.x, i0.y), 0).rgb;
  let c10 = textureLoad(tex, vec2i(i1.x, i0.y), 0).rgb;
  let c01 = textureLoad(tex, vec2i(i0.x, i1.y), 0).rgb;
  let c11 = textureLoad(tex, vec2i(i1.x, i1.y), 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn transmittanceLoad(
  lut: texture_2d<f32>, size: vec2f, planetRadius: f32, atmosphereRadius: f32, h: f32, mu: f32,
) -> vec3f {
  let unit = transmittanceUnit(planetRadius, atmosphereRadius, h, mu);
  let uv = vec2f(unitToTexCoord(unit.x, size.x), unitToTexCoord(unit.y, size.y));
  return fetchBilinear(lut, uv, size);
}

fn multiScatterLoad(
  lut: texture_2d<f32>, size: vec2f, planetRadius: f32, atmosphereRadius: f32, h: f32, sunCosZenith: f32,
) -> vec3f {
  let unit = multiScatterUnit(planetRadius, atmosphereRadius, h, sunCosZenith);
  let uv = vec2f(unitToTexCoord(unit.x, size.x), unitToTexCoord(unit.y, size.y));
  return fetchBilinear(lut, uv, size);
}
`;

/**
 * LUT 1 of 3 — `T(h, mu)`, the fraction of radiance surviving from altitude `h` to the top of the
 * atmosphere. Every later stage is a lookup into this.
 *
 * A LUT rather than Chapman's closed form: Chapman assumes purely exponential layers, so the ozone
 * tent needs an empirical fudge on top. This degenerates exactly (T ≡ 1) when every coefficient is
 * zero, with no special case.
 */
export const TRANSMITTANCE_WGSL = /* wgsl */ `
struct Uniforms {
  atm: Atmosphere,
  lutSize: vec2u,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var outTransmittance: texture_storage_2d<rgba16float, write>;

const TRANSMITTANCE_STEPS: u32 = 40u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u.lutSize.x || gid.y >= u.lutSize.y) { return; }
  let size = vec2f(u.lutSize);

  let uv = (vec2f(gid.xy) + 0.5) / size;
  let unit = vec2f(texCoordToUnit(uv.x, size.x), texCoordToUnit(uv.y, size.y));
  let p = transmittanceParams(u.atm.planetRadius, u.atm.atmosphereRadius, unit);

  let r = u.atm.planetRadius + p.h;
  let tMax = distanceToTop(r, p.mu, u.atm.atmosphereRadius);

  // Midpoint rule with uniform spacing: this integrand has no source term weighted toward the
  // viewer, so even spacing is the lower-variance choice at the same sample count.
  let ds = tMax / f32(TRANSMITTANCE_STEPS);
  var opticalDepth = vec3f(0.0);
  for (var i = 0u; i < TRANSMITTANCE_STEPS; i = i + 1u) {
    let t = (f32(i) + 0.5) * ds;
    let s = heightAt(u.atm.planetRadius, p.h, p.mu, t);
    opticalDepth = opticalDepth + sampleMedium(u.atm, s.h).extinction * ds;
  }

  textureStore(outTransmittance, vec2i(gid.xy), vec4f(exp(-opticalDepth), 1.0));
}
`;

/**
 * LUT 2 of 3 — the multi-scattering response, one workgroup per texel, 64 threads = 64 directions
 * over the sphere, reduced in workgroup memory.
 *
 * Single scattering alone makes a daytime sky far too dark: most of what the eye reads as "sky" is
 * light that bounced repeatedly. Assuming every order past the first is isotropic collapses the
 * infinite series into `L₂ · factor / (1 − f_ms)`.
 */
export const MULTISCATTER_WGSL = /* wgsl */ `
struct Uniforms {
  atm: Atmosphere,
  lutSize: vec2u,
  transmittanceSize: vec2u,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var outMultiScatter: texture_storage_2d<rgba16float, write>;

const MS_DIRECTIONS: u32 = 64u;
const MS_STEPS: u32 = 20u;
/// f_ms is an albedo and cannot reach 1, but an authored atmosphere can push the estimate there —
/// and the series would then divide by zero or go negative, which reads as a black sky.
const MS_MAX_GAIN: f32 = 0.98;

var<workgroup> gSecondOrder: array<vec3f, 64>;
var<workgroup> gGain: array<vec3f, 64>;

struct March { secondOrder: vec3f, gain: vec3f }

fn marchDirection(dir: vec3f, sunDir: vec3f, h: f32, transmittanceSize: vec2f) -> March {
  let atm = u.atm;
  let r = atm.planetRadius + h;
  let mu = dir.y;

  let tGround = distanceToGround(r, mu, atm.planetRadius);
  let tTop = distanceToTop(r, mu, atm.atmosphereRadius);
  var tMax = tTop;
  if (tGround >= 0.0) { tMax = tGround; }

  var out: March;
  out.secondOrder = vec3f(0.0);
  out.gain = vec3f(0.0);
  var throughput = vec3f(1.0);
  var tPrev = 0.0;

  for (var i = 0u; i < MS_STEPS; i = i + 1u) {
    let t = marchT((f32(i) + 1.0) / f32(MS_STEPS), tMax);
    let ds = t - tPrev;
    let tMid = 0.5 * (t + tPrev);
    tPrev = t;
    if (ds <= 0.0) { continue; }

    let s = heightAt(atm.planetRadius, h, mu, tMid);
    let medium = sampleMedium(atm, s.h);
    let segT = exp(-medium.extinction * ds);

    // Sun zenith AT THE SAMPLE, not at the cell: over a 700 km path the local up rotates enough
    // that using the cell's angle visibly flattens the terminator.
    let pos = vec3f(dir.x * tMid, r + dir.y * tMid, dir.z * tMid);
    let sunCos = clamp(dot(pos, sunDir) / max(s.r, 1e-6), -1.0, 1.0);
    var lit = 1.0;
    if (rayHitsGround(s.r, sunCos, atm.planetRadius)) { lit = 0.0; }
    let sunT = transmittanceLoad(
      transmittanceLut, transmittanceSize, atm.planetRadius, atm.atmosphereRadius, s.h, sunCos,
    );

    // The INNER isotropic phase: sunlight arrives from one direction, so scattering it into the
    // direction being marched costs a phase factor. The gain term gets none — its incident field is
    // uniform, and ∫p dω = 1 for any normalised phase function.
    let sunSource = medium.scattering * sunT * lit * phaseIsotropic();
    out.secondOrder = out.secondOrder + throughput * segmentIntegral(sunSource, medium.extinction, segT, ds);
    out.gain = out.gain + throughput * segmentIntegral(medium.scattering, medium.extinction, segT, ds);
    throughput = throughput * segT;
  }

  // Lambertian ground bounce — without it a bright surface fails to lift its own sky and the
  // horizon reads as a hard dark band. Second-order term only.
  if (tGround >= 0.0) {
    let s = heightAt(atm.planetRadius, h, mu, tGround);
    let pos = vec3f(dir.x * tGround, r + dir.y * tGround, dir.z * tGround);
    let sunCos = clamp(dot(pos, sunDir) / max(s.r, 1e-6), -1.0, 1.0);
    if (sunCos > 0.0) {
      let sunT = transmittanceLoad(
        transmittanceLut, transmittanceSize, atm.planetRadius, atm.atmosphereRadius, s.h, sunCos,
      );
      out.secondOrder = out.secondOrder + throughput * sunT * sunCos * atm.groundAlbedo.rgb * INV_PI;
    }
  }
  return out;
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(workgroup_id) groupId: vec3u, @builtin(local_invocation_id) localId: vec3u) {
  let size = vec2f(u.lutSize);
  let uv = (vec2f(groupId.xy) + 0.5) / size;
  let unit = vec2f(texCoordToUnit(uv.x, size.x), texCoordToUnit(uv.y, size.y));
  let p = multiScatterParams(u.atm.planetRadius, u.atm.atmosphereRadius, unit);

  // The LUT is rotationally symmetric about the zenith, so the sun may be placed in the XY plane.
  let sunSin = sqrt(saturate(1.0 - p.mu * p.mu));
  let sunDir = vec3f(sunSin, p.mu, 0.0);

  let i = localId.x;
  let m = marchDirection(sphereDirection(i, MS_DIRECTIONS), sunDir, p.h, vec2f(u.transmittanceSize));
  gSecondOrder[i] = m.secondOrder;
  gGain[i] = m.gain;
  workgroupBarrier();

  // Binary-tree reduction in workgroup memory, not wave intrinsics — those are not guaranteed in
  // WebGPU core, and the barrier has to stay in uniform control flow.
  for (var stride = MS_DIRECTIONS / 2u; stride > 0u; stride = stride >> 1u) {
    if (i < stride) {
      gSecondOrder[i] = gSecondOrder[i] + gSecondOrder[i + stride];
      gGain[i] = gGain[i] + gGain[i + stride];
    }
    workgroupBarrier();
  }

  if (i != 0u) { return; }

  // The OUTER isotropic phase cancels: ∫L·p_u dω over N uniform directions is (4π/N)·Σ L·(1/4π),
  // i.e. the plain mean. Hence 1/N here and no explicit 4π anywhere.
  let invN = 1.0 / f32(MS_DIRECTIONS);
  let l2 = gSecondOrder[0] * invN;
  let fMs = min(gGain[0] * invN, vec3f(MS_MAX_GAIN));
  let psi = l2 * u.atm.multiScatteringFactor / (vec3f(1.0) - fMs);
  textureStore(outMultiScatter, vec2i(groupId.xy), vec4f(min(psi, vec3f(ATM_MAX_LUT_RADIANCE)), 1.0));
}
`;

/**
 * LUT 3 of 3 — the whole visible sky ray-marched into a 192×108 image, so the background costs one
 * filtered fetch per pixel instead of a 32-step march.
 *
 * Contains single scattering (both phases) plus the second-order term. Does **not** contain the sun
 * disc: a 0.5°-wide feature that a 192-column LUT cannot represent, so it is evaluated analytically
 * per pixel in the final pass.
 */
export const SKYVIEW_WGSL = /* wgsl */ `
struct Uniforms {
  atm: Atmosphere,
  sunDirection: vec4f,
  sunIlluminance: vec4f,
  lutSize: vec2u,
  transmittanceSize: vec2u,
  multiScatterSize: vec2u,
  altitude: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var multiScatterLut: texture_2d<f32>;
@group(0) @binding(3) var outSkyView: texture_storage_2d<rgba16float, write>;

const SKYVIEW_STEPS: u32 = 32u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= u.lutSize.x || gid.y >= u.lutSize.y) { return; }

  let atm = u.atm;
  let h = u.altitude;
  let r = atm.planetRadius + h;
  let size = vec2f(u.lutSize);

  let uv = (vec2f(gid.xy) + 0.5) / size;
  let unit = vec2f(texCoordToUnit(uv.x, size.x), texCoordToUnit(uv.y, size.y));
  let angles = skyViewParams(atm.planetRadius, unit, h);

  // Work in the LUT's own frame: up = +Y, the sun's azimuth = +X. Only the sun's ELEVATION
  // survives from the world direction — the azimuth is the frame's definition, which is what makes
  // one 2D image cover every heading.
  let dir = skyViewDirection(angles.viewZenithCos, angles.lightViewCos);
  let sunCosZenith = clamp(u.sunDirection.y, -1.0, 1.0);
  let sunSinZenith = sqrt(saturate(1.0 - sunCosZenith * sunCosZenith));
  let sunDir = vec3f(sunSinZenith, sunCosZenith, 0.0);

  let cosTheta = clamp(dot(dir, sunDir), -1.0, 1.0);
  let phaseR = phaseRayleigh(cosTheta);
  let phaseM = phaseCornetteShanks(atm.mieAnisotropy, cosTheta);

  let mu = dir.y;
  let tGround = distanceToGround(r, mu, atm.planetRadius);
  let tTop = distanceToTop(r, mu, atm.atmosphereRadius);
  var tMax = tTop;
  if (tGround >= 0.0) { tMax = tGround; }

  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);
  var tPrev = 0.0;

  for (var i = 0u; i < SKYVIEW_STEPS; i = i + 1u) {
    let t = marchT((f32(i) + 1.0) / f32(SKYVIEW_STEPS), tMax);
    let ds = t - tPrev;
    let tMid = 0.5 * (t + tPrev);
    tPrev = t;
    if (ds <= 0.0) { continue; }

    let s = heightAt(atm.planetRadius, h, mu, tMid);
    let medium = sampleMedium(atm, s.h);
    let segT = exp(-medium.extinction * ds);

    let pos = vec3f(dir.x * tMid, r + dir.y * tMid, dir.z * tMid);
    let sunCos = clamp(dot(pos, sunDir) / max(s.r, 1e-6), -1.0, 1.0);
    var lit = 1.0;
    if (rayHitsGround(s.r, sunCos, atm.planetRadius)) { lit = 0.0; }
    let sunT = transmittanceLoad(
      transmittanceLut, vec2f(u.transmittanceSize), atm.planetRadius, atm.atmosphereRadius, s.h, sunCos,
    );
    let psiMs = multiScatterLoad(
      multiScatterLut, vec2f(u.multiScatterSize), atm.planetRadius, atm.atmosphereRadius, s.h, sunCos,
    );

    // Rayleigh and aerosol have different phases AND different spectra, so they cannot be folded
    // into one coefficient before the phase.
    let d = densities(atm, s.h);
    let phased = atm.rayleighScattering.rgb * d.x * phaseR + atm.mieScattering.rgb * d.y * phaseM;
    let source = u.sunIlluminance.rgb * (sunT * lit * phased + psiMs * medium.scattering);
    radiance = radiance + throughput * segmentIntegral(source, medium.extinction, segT, ds);
    throughput = throughput * segT;
  }

  textureStore(outSkyView, vec2i(gid.xy), vec4f(min(radiance, vec3f(ATM_MAX_LUT_RADIANCE)), 1.0));
}
`;

/**
 * The background evaluation: two filtered fetches, an analytic sun disc, a Lambertian ground, and
 * the one place exposure is applied.
 *
 * The engine emits raw radiance here and tonemaps later in the frame. This example has nowhere
 * later to put it — the next thing that happens is an 8-bit PNG — so exposure and the tonemap curve
 * live at the end of this shader, and that is the only deliberate departure from the original pass.
 *
 * The camera is a basis plus a field of view rather than an inverse view-projection matrix. Same
 * rays, one less thing for an example to get wrong.
 */
export const BACKGROUND_WGSL = /* wgsl */ `
struct Uniforms {
  atm: Atmosphere,
  sunDirection: vec4f,      // xyz = direction TO the sun; w = cos of its angular radius
  sunDiscRadiance: vec4f,   // rgb = E/Ω × colour; a = limb-darkening coefficient
  sunIlluminance: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  camForward: vec4f,
  lutSizes: vec4f,          // sky-view in .xy, transmittance in .zw
  altitude: f32,
  exposure: f32,
  tanHalfFov: f32,
  aspect: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var lutSampler: sampler;
@group(0) @binding(2) var skyViewLut: texture_2d<f32>;
@group(0) @binding(3) var transmittanceLut: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOut {
  // One oversized triangle rather than two triangles: no shared edge, no diagonal seam.
  var pos = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VertexOut;
  out.position = vec4f(pos[i], 0.0, 1.0);
  out.uv = vec2f(pos[i].x * 0.5 + 0.5, 0.5 - pos[i].y * 0.5);
  return out;
}

/// ACES filmic approximation (Narkowicz). Applied after exposure, before the sRGB transfer.
fn tonemapACES(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn encodeSrgb(x: vec3f) -> vec3f {
  let lo = x * 12.92;
  let hi = 1.055 * pow(max(x, vec3f(1e-5)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let dir = normalize(
    u.camForward.xyz
    + u.camRight.xyz * (ndc.x * u.tanHalfFov * u.aspect)
    + u.camUp.xyz * (ndc.y * u.tanHalfFov)
  );

  let sunDir = u.sunDirection.xyz;
  let h = u.altitude;
  let r = u.atm.planetRadius + h;
  let mu = dir.y;

  // ── in-scattered sky ──
  let lightViewCos = lightViewCosAbout(vec3f(0.0, 1.0, 0.0), dir, sunDir);
  let skyUv = skyViewUnit(u.atm.planetRadius, h, mu, lightViewCos);
  let inset = vec2f(unitToTexCoord(skyUv.x, u.lutSizes.x), unitToTexCoord(skyUv.y, u.lutSizes.y));
  var radiance = textureSampleLevel(skyViewLut, lutSampler, inset, 0.0).rgb;

  // ── view-ray transmittance: one fetch, two consumers ──
  let tGround = distanceToGround(r, mu, u.atm.planetRadius);
  let groundHit = tGround >= 0.0;
  let tUnit = transmittanceUnit(u.atm.planetRadius, u.atm.atmosphereRadius, h, mu);
  let viewT = textureSampleLevel(
    transmittanceLut,
    lutSampler,
    vec2f(unitToTexCoord(tUnit.x, u.lutSizes.z), unitToTexCoord(tUnit.y, u.lutSizes.w)),
    0.0,
  ).rgb;

  // ── sun disc, suppressed below the horizon ──
  let cosTheta = dot(dir, sunDir);
  if (!groundHit && cosTheta >= u.sunDirection.w) {
    let thetaR = acos(clamp(u.sunDirection.w, -1.0, 1.0));
    let theta = acos(clamp(cosTheta, -1.0, 1.0));
    let x = saturate(theta / max(thetaR, 1e-6));
    // Normalised so the profile REDISTRIBUTES the disc's flux instead of removing it: the area
    // average of 1 − u(1 − μ) is exactly 1 − u/3.
    let uLimb = saturate(u.sunDiscRadiance.a);
    let limb = (1.0 - uLimb * (1.0 - sqrt(saturate(1.0 - x * x)))) / (1.0 - uLimb / 3.0);
    radiance = radiance + u.sunDiscRadiance.rgb * limb * viewT;
  }

  // ── ground ──
  // The engine covers the lower hemisphere with real scene geometry and deliberately paints no
  // second ground under it. An example has no scene, so here is the cheapest honest one: a
  // Lambertian plane lit through the transmittance LUT, fading into the sky's own aerial
  // perspective with distance.
  if (groundHit) {
    let s = heightAt(u.atm.planetRadius, h, mu, tGround);
    let sunCos = clamp(dot(vec3f(dir.x * tGround, r + dir.y * tGround, dir.z * tGround), sunDir) / max(s.r, 1e-6), -1.0, 1.0);
    var ground = vec3f(0.0);
    if (sunCos > 0.0) {
      let sunT = transmittanceLoad(
        transmittanceLut, u.lutSizes.zw, u.atm.planetRadius, u.atm.atmosphereRadius, 0.0, sunCos,
      );
      ground = u.sunIlluminance.rgb * sunT * sunCos * u.atm.groundAlbedo.rgb * INV_PI;
    }
    // Distance fade: the sky-view radiance already integrated the column down to the ground, so
    // the ground is simply what is left of the far end of it.
    let fade = saturate(tGround / 40.0);
    radiance = radiance + ground * (1.0 - fade);
  }

  return vec4f(encodeSrgb(tonemapACES(radiance * u.exposure)), 1.0);
}
`;

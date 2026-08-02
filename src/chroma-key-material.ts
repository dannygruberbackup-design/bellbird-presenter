export type ChromaKeyOptions = {

  keyColor: number;

  similarity: number;

  smoothness: number;

  spill: number;

  lumaWeight: number;

  // Exposure multiplier applied after keying. Footage lit for a studio is
  // usually darker than the room it is composited into, and no amount of key
  // tuning fixes that — it is a brightness problem, not a matte problem.
  brightness: number;
  convertToLinear: boolean;
};

export const SCREEN_COLORS = {

  green: 0x00b140,

  blue: 0x0047bb,
} as const;

export const DEFAULT_CHROMA: ChromaKeyOptions = {
  keyColor: SCREEN_COLORS.green,

  similarity: 0.12,
  smoothness: 0.06,
  spill: 0.1,
  lumaWeight: 0.3,
  brightness: 1,
  convertToLinear: true,
};

const vertexShader =  `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader =  `
  uniform sampler2D uMap;
  uniform vec3  uKeyColor;
  uniform float uSimilarity;
  uniform float uSmoothness;
  uniform float uSpill;
  uniform float uLumaWeight;
  uniform float uKeyLuma;
  uniform float uOpacity;
  uniform float uBrightness;
  uniform float uConvertToLinear;
  // Fractions trimmed off each edge: x left, y right, z top, w bottom.
  uniform vec4  uCrop;

  varying vec2 vUv;

  // RGB -> the Cb/Cr pair only. Luminance is deliberately discarded.
  vec2 rgbToCbCr(vec3 c) {
    return vec2(
      c.r * -0.168736 + c.g * -0.331264 + c.b *  0.500000 + 0.5,
      c.r *  0.500000 + c.g * -0.418688 + c.b * -0.081312 + 0.5
    );
  }

  vec3 sRGBToLinear(vec3 c) {
    return mix(
      pow((c + 0.055) / 1.055, vec3(2.4)),
      c / 12.92,
      step(c, vec3(0.04045))
    );
  }

  void main() {
    // Sample only the kept window of the source frame. Cropping here rather
    // than by shrinking the plane means the geometry, the tap target and the
    // shadow all stay in step with what is actually visible.
    vec2 uv = vec2(
      uCrop.x + vUv.x * (1.0 - uCrop.x - uCrop.y),
      uCrop.w + vUv.y * (1.0 - uCrop.z - uCrop.w)
    );
    vec4 texel = texture2D(uMap, uv);

    float luma = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));

    // Hue distance, plus a share of the brightness difference. The second term
    // rescues dark clothing that has picked up screen spill: it is the wrong
    // hue to survive on chroma alone, but far too dark to be the screen.
    float chromaDist = distance(rgbToCbCr(texel.rgb), rgbToCbCr(uKeyColor))
                     + uLumaWeight * abs(luma - uKeyLuma);

    // Distance beyond the key radius, before softening.
    float baseMask = chromaDist - uSimilarity;

    // Alpha ramp. The 1.5 exponent biases the falloff towards transparency,
    // which keeps semi-keyed edge pixels from reading as a green halo.
    float alpha = pow(clamp(baseMask / uSmoothness, 0.0, 1.0), 1.5);

    // Spill suppression: pixels that only just survived the key get pulled
    // towards their own luminance, draining residual green from hair and
    // shoulders without touching skin or clothing.
    float spillFactor = pow(clamp(baseMask / uSpill, 0.0, 1.0), 1.5);
    vec3 rgb = mix(vec3(luma), texel.rgb, spillFactor);

    // Exposure before the colour-space step, so it behaves like a light on her
    // rather than a wash over the final pixel.
    rgb = clamp(rgb * uBrightness, 0.0, 1.0);

    rgb = mix(rgb, sRGBToLinear(rgb), uConvertToLinear);

    gl_FragColor = vec4(rgb, alpha * uOpacity);

    if (gl_FragColor.a < 0.01) discard;
  }
`;

export function createChromaKeyMaterial(
  THREE: any,
  videoTexture: any,
  options: ChromaKeyOptions,
): any {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: videoTexture },
      uKeyColor: { value: makeKeyColor(THREE, options.keyColor) },
      uSimilarity: { value: options.similarity },
      uSmoothness: { value: options.smoothness },
      uSpill: { value: options.spill },
      uLumaWeight: { value: options.lumaWeight },
      uKeyLuma: { value: keyLuma(options.keyColor) },
      uOpacity: { value: 1 },
      uBrightness: { value: options.brightness },
      uConvertToLinear: { value: options.convertToLinear ? 1 : 0 },
      uCrop: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
    vertexShader,
    fragmentShader,
    transparent: true,

    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  return material;
}

export function keyLuma(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function applyKeyColor(THREE: any, color: any, hex: number): void {
  if (THREE.LinearSRGBColorSpace !== undefined && color.setHex.length >= 2) {
    color.setHex(hex, THREE.LinearSRGBColorSpace);
  } else {
    color.setHex(hex);
  }
}

function makeKeyColor(THREE: any, hex: number): any {
  const color = new THREE.Color();
  applyKeyColor(THREE, color, hex);
  return color;
}

export function setNoColorConversion(THREE: any, texture: any): void {
  if ('colorSpace' in texture && THREE.NoColorSpace !== undefined) {
    texture.colorSpace = THREE.NoColorSpace;
  } else if (THREE.LinearEncoding !== undefined) {
    texture.encoding = THREE.LinearEncoding;
  }
}

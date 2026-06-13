import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { GRAPHICS } from './constants';

/**
 * Post-processing pipeline (RENDER-ONLY — never touches sim/RNG/clock).
 *
 * Chain: RenderPass → UnrealBloomPass → FXAA (ShaderPass) → OutputPass.
 *
 * Tonemapping correctness
 * -----------------------
 * `renderer.toneMapping` is set to ACESFilmic and `OutputPass` (last in the
 * chain) reads `renderer.toneMapping` + `renderer.outputColorSpace` at render
 * time and applies the tonemap + sRGB conversion exactly ONCE. The intermediate
 * composer render targets are linear-HDR; `RenderPass` does NOT tonemap when
 * rendering into a render target, so the scene + bloom accumulate in linear
 * space and only `OutputPass` maps to display. We therefore do NOT add any
 * separate tonemap pass and do NOT touch `renderer.outputColorSpace` — doing
 * either would double-tonemap and wash the image out.
 *
 * The whole constructor is wrapped in try/catch: on any failure `ok` is false
 * and the caller falls back to `renderer.render(scene, camera)`. Importing /
 * instantiating this module has no effect on the sim and never runs in tests
 * (there is no GL context under bun).
 */
export class PostFX {
  /** False if construction failed — caller must fall back to direct rendering. */
  readonly ok: boolean;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private fxaaPass: ShaderPass | null = null;
  private outputPass: OutputPass | null = null;

  private readonly renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    let constructed = false;

    try {
      // Filmic tonemap + exposure live on the renderer; OutputPass consumes them.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = GRAPHICS.exposure;

      const size = renderer.getSize(new THREE.Vector2());
      const w = Math.max(1, size.x);
      const h = Math.max(1, size.y);
      const pr = renderer.getPixelRatio();

      const composer = new EffectComposer(renderer);

      const renderPass = new RenderPass(scene, camera);
      composer.addPass(renderPass);

      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        GRAPHICS.bloom.strength,
        GRAPHICS.bloom.radius,
        GRAPHICS.bloom.threshold,
      );
      composer.addPass(bloomPass);

      // FXAA operates in device pixels — resolution uniform = 1 / (px * pr).
      const fxaaPass = new ShaderPass(FXAAShader);
      const fxaaRes = fxaaPass.material.uniforms['resolution'];
      if (fxaaRes) {
        (fxaaRes.value as THREE.Vector2).set(1 / (w * pr), 1 / (h * pr));
      }
      composer.addPass(fxaaPass);

      // MUST be last: applies ACES tonemap + sRGB once.
      const outputPass = new OutputPass();
      composer.addPass(outputPass);

      // Match composer internal buffers to the device-pixel resolution.
      composer.setPixelRatio(pr);
      composer.setSize(w, h);

      this.composer = composer;
      this.renderPass = renderPass;
      this.bloomPass = bloomPass;
      this.fxaaPass = fxaaPass;
      this.outputPass = outputPass;
      constructed = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[PostFX] init failed — falling back to direct rendering:', err);
      constructed = false;
    }

    this.ok = constructed;
  }

  /** Render the full post-processing chain. No per-frame heap allocations. */
  render(): void {
    if (this.composer) this.composer.render();
  }

  /**
   * Resize composer + bloom + FXAA. `width`/`height` are CSS pixels; the FXAA
   * resolution uniform must account for the renderer's pixel ratio.
   */
  setSize(width: number, height: number): void {
    if (!this.composer) return;
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const pr = this.renderer.getPixelRatio();

    // composer.setSize resizes every pass (incl. bloom) at device-pixel
    // resolution (w * pixelRatio). An explicit bloomPass.setSize(w,h) here
    // would override that with raw CSS pixels and downscale bloom at DPR>1.
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);

    if (this.fxaaPass) {
      const fxaaRes = this.fxaaPass.material.uniforms['resolution'];
      if (fxaaRes) {
        (fxaaRes.value as THREE.Vector2).set(1 / (w * pr), 1 / (h * pr));
      }
    }
  }

  /** Dispose composer render targets + all passes. */
  dispose(): void {
    if (this.composer) this.composer.dispose();
    if (this.bloomPass) this.bloomPass.dispose();
    if (this.outputPass) this.outputPass.dispose();
    // RenderPass / ShaderPass have no GPU-owned resources beyond their fullscreen
    // material; dispose if present (newer three exposes pass.dispose()).
    if (this.fxaaPass && typeof (this.fxaaPass as { dispose?: () => void }).dispose === 'function') {
      (this.fxaaPass as { dispose: () => void }).dispose();
    }
    if (this.renderPass && typeof (this.renderPass as { dispose?: () => void }).dispose === 'function') {
      (this.renderPass as { dispose: () => void }).dispose();
    }
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.fxaaPass = null;
    this.outputPass = null;
  }
}

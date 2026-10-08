declare module 'butterchurn' {
  export interface AudioLevels {
    timeByteArray: Uint8Array;
    timeByteArrayL: Uint8Array;
    timeByteArrayR: Uint8Array;
  }

  export interface ButterchurnVisualizer {
    loadPreset(preset: object, blendTime: number): void;
    setRendererSize(width: number, height: number, opts?: { pixelRatio?: number; textureRatio?: number }): void;
    render(opts?: { audioLevels?: AudioLevels; elapsedTime?: number }): void;
  }

  const butterchurn: {
    createVisualizer(
      context: BaseAudioContext | null,
      canvas: HTMLCanvasElement,
      opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
    ): ButterchurnVisualizer;
  };
  export default butterchurn;
}

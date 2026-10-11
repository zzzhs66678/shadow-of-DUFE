import type { ISizeCalculationResult } from "./index.mjs";

export declare function setConcurrency(concurrency: number): void;
export declare function imageSizeFromFile(
  filePath: string,
): Promise<ISizeCalculationResult>;

import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers"
import { join } from "node:path"
import type { Config, EmbeddingModel } from "./config.ts"

/** Turns text into normalized vectors with a local ONNX model. Nothing leaves the machine. */
export class Embedder {
  private extractor: Promise<FeatureExtractionPipeline> | undefined
  private readonly model: EmbeddingModel

  constructor(private readonly config: Config) {
    this.model = config.model
    env.cacheDir = join(config.dataDir, "models")
  }

  private load(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= pipeline("feature-extraction", this.model.id, {
      dtype: "q8",
      session_options: { intraOpNumThreads: this.config.threads, interOpNumThreads: 1 },
    }) as Promise<FeatureExtractionPipeline>
    return this.extractor
  }

  async passages(texts: readonly string[]): Promise<Float32Array[]> {
    return this.embed(texts)
  }

  async query(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([this.model.queryPrefix + text])
    return vector!
  }

  private async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const extractor = await this.load()
    const output = await extractor([...texts], { pooling: this.model.pooling, normalize: true })
    const data = output.data as Float32Array
    const size = this.model.dimensions
    return texts.map((_, index) => data.slice(index * size, (index + 1) * size))
  }
}

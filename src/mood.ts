import { pipeline, type TextClassificationPipeline } from "@huggingface/transformers";

export interface MoodReading {
  valence: number; // -1..1
  energy: number; // 0..1
  label: string; // for the status dot
  confidence: number;
  /** True when tonality from the mic contributed to this reading. */
  fromVoice?: boolean;
  /** Set when words and voice disagree — which channel read better. */
  divergent?: "words" | "voice" | null;
}

let classifier: TextClassificationPipeline | null = null;
let loading: Promise<TextClassificationPipeline | null> | null = null;

/** Lazily load the sentiment model. Returns null if it can't load. */
function load(): Promise<TextClassificationPipeline | null> {
  if (classifier) return Promise.resolve(classifier);
  if (!loading) {
    loading = pipeline(
      "text-classification",
      "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
      { dtype: "q8" }
    )
      .then((p) => {
        classifier = p as TextClassificationPipeline;
        console.log("[mood] classifier ready");
        return classifier;
      })
      .catch((err) => {
        console.error("[mood] load failed:", err);
        return null;
      });
  }
  return loading;
}

/** Kick off loading early (called at startup, fire-and-forget). */
export function warmMood(): void {
  void load();
}

export async function readMood(text: string): Promise<MoodReading | null> {
  const c = await load();
  if (!c) return null;
  try {
    const out = (await c(text, { top_k: 1 })) as Array<{
      label: string;
      score: number;
    }>;
    const { label, score } = out[0];
    const positive = label === "POSITIVE";
    // Map raw sentiment to our two axes. Energy follows confidence when the
    // reading is strong, drifts toward restless when neutral-weak.
    const valence = positive ? score : -score;
    const energy = 0.25 + 0.65 * Math.abs(valence) + (1 - score) * 0.2;
    return {
      valence,
      energy: Math.min(1, energy),
      label: positive ? "warm" : "low",
      confidence: score,
    };
  } catch (err) {
    console.error("[mood] inference failed:", err);
    return null;
  }
}
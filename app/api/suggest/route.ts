import { generateObject, jsonSchema } from "ai";
import { AiConfigError, getModel } from "@/lib/ai/registry";

export const maxDuration = 30;

interface Suggestions {
  suggestions: { label: string; prompt: string; action: "chat" | "statue" }[];
}

const SCHEMA = jsonSchema<Suggestions>({
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "prompt", "action"],
        properties: {
          label: { type: "string", description: "Chip text, at most ~6 words" },
          prompt: {
            type: "string",
            description: "Full chat message sent when clicked (empty for statue actions)",
          },
          action: {
            type: "string",
            enum: ["chat", "statue"],
            description: "statue = run the photo-to-3D statue generator directly",
          },
        },
      },
    },
  },
});

const PROMPT = `You are looking at a photo a user just attached to ask3d, a chatbot that turns descriptions into 3D-printable models (OpenSCAD → STL, Bambu A1 printer, 256mm build volume). The app can also:
- generate a full 3D statue from the photo via a "statue" action (best for organic subjects: people, pets, plants, objects with sculptural depth),
- emboss the photo as a relief plaque or lithophane via chat,
- design objects that incorporate or reference the subject via chat (stands, pedestals with engraved names, cookie cutters, ornaments, hooks).

Suggest 3 concrete next steps tailored to WHAT IS IN THIS PHOTO. Mention the subject specifically (e.g. "this dog", "your mug"). Exactly one suggestion should be action "statue" if the subject suits a statue, with an empty prompt. Chat prompts must be complete, printable requests with sensible millimeter sizes. Labels are button text: short, no punctuation beyond needed.`;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { image?: unknown } | null;
    const image = body?.image;
    if (typeof image !== "string" || !image.startsWith("data:image/") || image.length > 2_000_000) {
      return Response.json({ error: "expected a small data-URL image" }, { status: 400 });
    }
    const { object } = await generateObject({
      model: getModel(),
      schema: SCHEMA,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image", image },
          ],
        },
      ],
    });
    return Response.json(object);
  } catch (error) {
    const status = error instanceof AiConfigError ? 503 : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "suggestion generation failed" },
      { status },
    );
  }
}

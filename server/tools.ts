import type Anthropic from "@anthropic-ai/sdk";

export interface RoomState {
  palette?: string; // warm | cool | dim | vivid | stark
  intensity?: number; // 0..1
  weather?: string; // clear | overcast | rain | storm | snow | fog
  particleEnergy?: number; // 0..1
  drift?: string; // still | breeze | gusts
}

export const roomTools: Anthropic.Tool[] = [
  {
    name: "set_light",
    description:
      "Change the light of the room. Use when the tone of the conversation turns and the light should follow.",
    input_schema: {
      type: "object",
      properties: {
        palette: {
          type: "string",
          enum: ["warm", "cool", "dim", "vivid", "stark"],
          description: "The character of the light.",
        },
        intensity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Brightness, 0 = nearly dark, 1 = full light.",
        },
      },
      required: ["palette", "intensity"],
    },
  },
  {
    name: "set_weather",
    description:
      "Change the weather of the room. Weather is the room's larger mood — bring it when the conversation genuinely warrants it, not every turn. Weather tints the light; it never fully covers the mood color the room is already holding.",
    input_schema: {
      type: "object",
      properties: {
        weather: {
          type: "string",
          enum: ["clear", "overcast", "rain", "storm", "snow", "fog"],
        },
      },
      required: ["weather"],
    },
  },
  {
    name: "set_ambience",
    description:
      "Change the motion of the air: how the ambient particles drift.",
    input_schema: {
      type: "object",
      properties: {
        particle_energy: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "How active the air is. 0 = still, 1 = swirling.",
        },
        drift: {
          type: "string",
          enum: ["still", "breeze", "gusts"],
        },
      },
      required: ["particle_energy", "drift"],
    },
  },
];

/**
 * Room tools are visual: their "execution" is telling the browser to change
 * the room. The server turns each call into an SSE event and always reports
 * success back to Claude.
 */
export function executeRoomTool(
  call: Anthropic.Messages.ToolUseBlock,
  emitRoom: (room: any) => void
): string {
  const input = call.input as RoomState;
  const room: RoomState & { tool: string } = { tool: call.name };
  if (call.name === "set_light") {
    room.palette = input.palette;
    room.intensity = input.intensity;
  } else if (call.name === "set_weather") {
    room.weather = input.weather;
  } else if (call.name === "set_ambience") {
    room.particleEnergy = (input as Record<string, number>).particle_energy;
    room.drift = input.drift;
  } else {
    return `Unknown tool: ${call.name}`;
  }
  emitRoom(room);
  console.log(`[room] ${call.name}`, JSON.stringify(call.input));
  return "done";
}
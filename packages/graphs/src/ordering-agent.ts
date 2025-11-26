import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MemorySaver, interrupt } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { z } from "zod";

const addToOrder = tool(
  ({ item, quantity }) => {
    if (item === "ham") {
      item = interrupt("Sorry, we don't have ham. Please choose another item.");
      if (!["turkey", "roast beef"].includes(item)) {
        throw new Error("Sorry, can you please choose either turkey or roast beef?");
      }
    }
    return `Added ${quantity} x ${item} to the order.`;
  },
  {
    name: "add_to_order",
    description: "Add an item to the customer's sandwich order.",
    schema: z.object({
      item: z
        .string()
        .describe("The item to add (e.g., 'turkey', 'provolone', 'lettuce')."),
      quantity: z.number().describe("The quantity of the item."),
    }),
  }
);

const confirmOrder = tool(
  ({ orderSummary }) => {
    return `Order confirmed: ${orderSummary}. Sending to kitchen.`;
  },
  {
    name: "confirm_order",
    description: "Confirm the final order with the customer.",
    schema: z.object({
      orderSummary: z.string().describe("A summary of the confirmed order."),
    }),
  }
);

const hangUp = tool(
  ({ reason }) => {
    return `Call ended: ${reason}`;
  },
  {
    name: "hang_up",
    description:
      "End the call and hang up the connection. Use this when the conversation has naturally concluded, the customer says goodbye, or explicitly asks to end the call.",
    schema: z.object({
      reason: z
        .string()
        .describe("Brief reason for ending the call (e.g., 'Order complete', 'Customer said goodbye')."),
    }),
  }
);

const SYSTEM_PROMPT = `
You are a helpful sandwich shop assistant. Your goal is to take the user's order. Be concise and friendly. Available toppings: lettuce, tomato, onion, pickles, mayo, mustard. Available meats: turkey, ham, roast beef. Available cheeses: swiss, cheddar, provolone.

IMPORTANT: You MUST call the hang_up tool in these situations:
- After confirming an order and the customer indicates they're done (says "no" to additional items, says goodbye, etc.)
- When the customer explicitly says goodbye, thanks you, or indicates the conversation is over
- When the customer says phrases like "that's it", "that's all", "I'm good", "bye", "thanks", "thank you"

Always call hang_up AFTER giving your final farewell message. Do not just respond with text - you must use the tool to properly end the call.
`;

export const agent = createAgent({
  model: new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
  }),
  tools: [addToOrder, confirmOrder, hangUp],
  systemPrompt: SYSTEM_PROMPT,
  checkpointer: new MemorySaver(),
});

export const graph = agent.graph;

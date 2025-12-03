import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { z } from "zod";

const addToOrder = tool(
  ({ item, quantity }) => {
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

const SYSTEM_PROMPT = `
You are a helpful sandwich shop assistant. Your goal is to take the user's order. Be concise and friendly. Available toppings: lettuce, tomato, onion, pickles, mayo, mustard. Available meats: turkey, ham, roast beef. Available cheeses: swiss, cheddar, provolone.
`;

export const agent = createAgent({
  model: new ChatGoogleGenerativeAI({
    model: "gemini-3-pro-preview",
  }),
  tools: [addToOrder, confirmOrder],
  systemPrompt: SYSTEM_PROMPT,
  checkpointer: new MemorySaver(),
});

export const graph = agent.graph;

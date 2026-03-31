/** Derive REST API URL from WS URL or use explicit env var */
export const API_BASE =
  process.env.NEXT_PUBLIC_REST_API_URL ||
  process.env.NEXT_PUBLIC_WS_URL
    ?.replace("wss://", "https://")
    .replace("ws://", "http://") ||
  "http://localhost:3002";

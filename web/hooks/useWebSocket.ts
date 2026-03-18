"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

interface UseWebSocketOptions {
  url: string;
  channels?: string[];
  onMessage?: (data: any) => void;
  reconnectInterval?: number;
  maxRetries?: number;
}

export function useWebSocket({
  url,
  channels = [],
  onMessage,
  reconnectInterval = 3000,
  maxRetries = 10,
}: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus("connecting");
    const ws = new WebSocket(url);

    ws.onopen = () => {
      setStatus("connected");
      retriesRef.current = 0;

      // Subscribe to channels
      if (channels.length > 0) {
        ws.send(JSON.stringify({ type: "subscribe", channels }));
      }

      // Start heartbeat
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 15000);

      ws.onclose = () => {
        clearInterval(heartbeat);
        setStatus("disconnected");
        wsRef.current = null;

        // Reconnect
        if (retriesRef.current < maxRetries) {
          retriesRef.current++;
          setTimeout(connect, reconnectInterval);
        }
      };
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type !== "pong") {
          onMessage?.(data);
        }
      } catch {}
    };

    ws.onerror = () => {
      setStatus("error");
    };

    wsRef.current = ws;
  }, [url, channels, onMessage, reconnectInterval, maxRetries]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const disconnect = useCallback(() => {
    retriesRef.current = maxRetries; // prevent reconnect
    wsRef.current?.close();
  }, [maxRetries]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { status, send, disconnect };
}

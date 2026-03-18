import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import cors from "cors";
import { initDatabase } from "./backend/database.js";
import { startTradingEngine } from "./backend/main.js";
import { setupWebsocket } from "./backend/api/websocket.js";
import { apiRouter } from "./backend/api/routes.js";
import { seedDatabase } from "./seed.js";
import { performBackup } from "./backend/backup.js";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  app.use((req, res, next) => {
    console.log('Request:', req.method, req.url);
    next();
  });

  // Initialize database
  initDatabase();
  
  // Seed database with mock data
  seedDatabase();

  // Schedule daily backup
  performBackup(); // Run once on startup
  setInterval(performBackup, 24 * 60 * 60 * 1000); // Daily backup

  // API routes
  app.use("/api", (req, res, next) => {
    console.log('API route hit:', req.url);
    next();
  }, apiRouter);

  const server = createServer(app);
  
  // Setup WebSocket
  const wss = new WebSocketServer({ server });
  setupWebsocket(wss);

  // Start trading engine
  startTradingEngine(wss);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

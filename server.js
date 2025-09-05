import { createServer } from "http";
import { Server } from "socket.io";

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// In-memory storage (for demo only)
const users = new Map(); // userId -> socket.id
const online = new Set();

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Client must provide userId when joining
  socket.on("join", ({ userId }) => {
    users.set(userId, socket.id);
    online.add(userId);
    console.log(`${userId} joined`);
    socket.broadcast.emit("presence:online", { userId });
  });

  // Handle private message
  socket.on("message:send", ({ to, text }, ack) => {
    const from = [...users.entries()].find(([, id]) => id === socket.id)?.[0];
    if (!from) return;

    const msg = { id: Date.now().toString(), from, to, text, status: "sent" };

    // Send to recipient if online
    const toSocketId = users.get(to);
    if (toSocketId) {
      io.to(toSocketId).emit("message:new", msg);
      msg.status = "delivered";
      // notify sender delivered
      socket.emit("message:delivered", { messageId: msg.id, to });
    }

    // Acknowledge back to sender
    ack?.({ ok: true, message: msg });
  });

  // Typing indicator
  socket.on("typing", ({ to, roomId }) => {
    console.log("Typing event received", { to, roomId });
    const from = [...users.entries()].find(([, id]) => id === socket.id)?.[0];
    const toSocketId = users.get(roomId);
    console.log("Typing event from", from, "to", toSocketId);
    if (from && toSocketId) io.to(toSocketId).emit("typing", { from });
  });

  // Read receipt
  socket.on("message:read", ({ messageId, to }) => {
    const from = [...users.entries()].find(([, id]) => id === socket.id)?.[0];
    const toSocketId = users.get(to);
    if (from && toSocketId)
      io.to(toSocketId).emit("message:read", { messageId, userId: from });
  });

  socket.on("disconnect", () => {
    const userId = [...users.entries()].find(([, id]) => id === socket.id)?.[0];
    if (userId) {
      users.delete(userId);
      online.delete(userId);
      socket.broadcast.emit("presence:offline", { userId });
      console.log(`${userId} disconnected`);
    }
  });

  socket.on("connect_error", (err) => {
    console.log("❌ Connection error:", err.message);
  });
});

httpServer.listen(4000, () =>
  console.log("Socket chat server running on :4000")
);

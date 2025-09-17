import { createServer } from "http";
import express from "express";
import { Server } from "socket.io";
import mysql from "mysql2/promise";
import multer from "multer";
import path from "path";
import fs from "fs";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "vesco",
});

// API: File upload
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const fileUrl = `/uploads/${req.file.filename}`;
  const fileType = getFileType(req.file.mimetype);
  res.json({ fileUrl, fileType });
});

app.use("/uploads", express.static(uploadDir));

function getFileType(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

// --- Helper functions ---
async function getUserIdBySocket(socketId) {
  const [rows] = await pool.query(
    "SELECT user_id FROM user_sessions WHERE socket_id = ?",
    [socketId]
  );
  return rows.length ? rows[0].user_id : null;
}

async function getRoomMembers(roomId) {
  const [rows] = await pool.query(
    "SELECT user_id FROM chat_room_members WHERE room_id = ?",
    [roomId]
  );
  return rows.map((r) => r.user_id);
}

// --- Socket Logic ---
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join", async ({ userId }) => {
    // await pool.query(
    //   "INSERT INTO user_sessions (user_id, socket_id) VALUES (?, ?)",
    //   [userId, socket.id]
    // );
    socket.broadcast.emit("presence:online", { userId });
  });

  socket.on("message:send", async ({ roomId, toUsers, text, fileUrl, fileType }, ack) => {
    const from = await getUserIdBySocket(socket.id);
    if (!from) return;

    let finalRoomId = roomId;

    // If no roomId provided, create new room (direct chat)
    if (!finalRoomId && toUsers?.length === 1) {
      finalRoomId = Date.now();
      await pool.query("INSERT INTO chat_rooms (id, type) VALUES (?, 'direct')", [finalRoomId]);
      await pool.query("INSERT INTO chat_room_members (room_id, user_id) VALUES (?, ?), (?, ?)", [
        finalRoomId,
        from,
        finalRoomId,
        toUsers[0],
      ]);
    }

    const messageId = Date.now();
    await pool.query(
      "INSERT INTO messages (id, room_id, sender_id, text, file_url, file_type) VALUES (?, ?, ?, ?, ?, ?)",
      [messageId, finalRoomId, from, text || null, fileUrl || null, fileType || null]
    );

    const msg = {
      id: messageId,
      roomId: finalRoomId,
      from,
      text: text || null,
      fileUrl: fileUrl || null,
      fileType: fileType || null,
      status: "sent",
    };

    // Broadcast to all room members
    const members = await getRoomMembers(finalRoomId);
    if (members.length) {
      const [sessions] = await pool.query(
        "SELECT socket_id FROM user_sessions WHERE user_id IN (?)",
        [members]
      );
      sessions.forEach(({ socket_id }) => {
        io.to(socket_id).emit("message:new", msg);
      });

      await pool.query("UPDATE messages SET status = 'delivered' WHERE id = ?", [
        messageId,
      ]);
      msg.status = "delivered";
      socket.emit("message:delivered", { messageId });
    }

    ack?.({ ok: true, message: msg });
  });

  socket.on("message:read", async ({ messageId }) => {
    const userId = await getUserIdBySocket(socket.id);
    if (!userId) return;

    await pool.query(
      "INSERT IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)",
      [messageId, userId]
    );

    // Notify others in room
    const [[{ room_id }]] = await pool.query(
      "SELECT room_id FROM messages WHERE id = ?",
      [messageId]
    );

    const members = await getRoomMembers(room_id);
    const [sessions] = await pool.query(
      "SELECT socket_id FROM user_sessions WHERE user_id IN (?)",
      [members.filter((id) => id !== userId)]
    );
    sessions.forEach(({ socket_id }) => {
      io.to(socket_id).emit("message:read", { messageId, userId });
    });
  });

  socket.on("disconnect", async () => {
    const userId = await getUserIdBySocket(socket.id);
    if (userId) {
      await pool.query("DELETE FROM user_sessions WHERE socket_id = ?", [
        socket.id,
      ]);
      const [sessions] = await pool.query(
        "SELECT * FROM user_sessions WHERE user_id = ?",
        [userId]
      );
      if (sessions.length === 0) {
        socket.broadcast.emit("presence:offline", { userId });
      }
    }
  });
});

httpServer.listen(4000, () =>
  console.log("Chat service running on :4000")
);

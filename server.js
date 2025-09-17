import { createServer } from "http";
import express from "express";
import { Server } from "socket.io";
import mysql from "mysql2/promise";
import fetch from "node-fetch";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "vesco",
});

const users = new Map(); // DB userId -> socketId
const online = new Set(); // DB userIds currently online

// ------------------ DB HELPERS ------------------ //
async function getUserByMemberId(memberId) {
  const [rows] = await pool.query("SELECT * FROM users WHERE memberId = ?", [
    memberId,
  ]);
  return rows[0] || null;
}

async function getUserByDbId(userId) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [userId]);
  return rows[0] || null;
}

async function createUser(memberId, name, appName) {
  const [result] = await pool.query(
    "INSERT INTO users (memberId, name, appName) VALUES (?, ?, ?)",
    [memberId, name, appName]
  );
  return result.insertId;
}

async function findChatroom(user1, user2, chatType) {
  const [rows] = await pool.query(
    `
    SELECT id FROM chatrooms 
    WHERE chat_type = ? AND 
    ((user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?))
    LIMIT 1;
    `,
    [chatType, user1, user2, user2, user1]
  );
  return rows[0]?.id || null;
}

// ------------------ NOTIFICATION HELPER ------------------ //
async function sendNotification(toUserObj, msg, fromUserId) {
  const [devices] = await pool.query(
    "SELECT * FROM devices WHERE user_id = ?",
    [toUserObj.id]
  );
  const fromUser = await getUserByDbId(fromUserId);
  for (const device of devices) {
    const payload = {
      to: device.token,
      sound: "default",
      title: fromUser?.name || "New Message",
      body:
        msg.message_type === "text"
          ? msg.message
          : msg.message_type === "image"
          ? "📷 Photo"
          : msg.message_type === "video"
          ? "📹 Video"
          : msg.message_type === "pdf"
          ? "📄 Document"
          : "New Message",
      data: { message: msg },
    };

    if (device.token_type === "expo") {
      fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    }
  }
}

// ------------------ SOCKET HELPERS ------------------ //
function findSocketUserId(socketId) {
  return [...users.entries()].find(([, sid]) => sid === socketId)?.[0] || null;
}

// ------------------ SOCKET EVENTS ------------------ //
io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  socket.on(
    "join",
    async ({ userId: memberId, chatId, name, appName, device, chat_type }) => {
      try {
        let user = await getUserByMemberId(memberId);
        if (!user) {
          const newId = await createUser(memberId, name, appName);
          user = await getUserByDbId(newId);
        }

        users.set(user.id, socket.id);
        online.add(user.id);

        if (device) {
          const { token, device_name, device_id, token_type } = device;

          const [checkDevice] = await pool.query(
            "SELECT * FROM devices WHERE user_id = ? AND device_id = ? AND token = ?",
            [user.id, device_id, token]
          );

          if (checkDevice.length === 0) {
            await pool.query(
              `INSERT INTO devices (user_id, token, device_name, device_id, token_type)
              VALUES (?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE 
              token = VALUES(token),
              device_name = VALUES(device_name),
              token_type = VALUES(token_type)
            `,
              [user.id, token, device_name, device_id, token_type]
            );
          }
        }

        let roomId = null;
        if (chatId) {
          const otherUser = await getUserByMemberId(chatId);
          if (otherUser) {
            roomId = await findChatroom(user.id, otherUser.id, chat_type);
          }
        }

        console.log(`👤 User ${user.id} (memberId ${user.memberId}) joined`, roomId);

        socket.broadcast.emit("presence:online", { userId: user.id });
        io.to(socket.id).emit("joined", { userId: user.id, roomId });
      } catch (error) {
        console.error("❌ Error in join handler:", error);
        socket.emit("error", { message: "Internal server error" });
      }
    }
  );

  socket.on("typing", async ({ from, to: memberId, isTyping }) => {
    try {
      const toUser = await getUserByMemberId(memberId);
      if (!toUser) return;
      const toSocketId = users.get(toUser.id);
      if (toSocketId) {
        io.to(toSocketId).emit("typing", { from, to: toUser.id, isTyping });
      }
    } catch (error) {
      console.error("typing event error:", error);
    }
  });

  socket.on("message:send", async (data, ack) => {
    try {
      const { to, message, from: fromUser, type, chatType, roomId } = data;
      const toUserObj = await getUserByMemberId(to.userId);

      let chatroomId =
        roomId || (await findChatroom(fromUser, toUserObj.id, chatType));
      if (!chatroomId && !roomId) {
        const [res] = await pool.query(
          "INSERT INTO chatrooms (chat_type, user1_id, user2_id) VALUES (?, ?, ?)",
          [chatType, fromUser, toUserObj.id]
        );
        chatroomId = res.insertId;
      }

      const msg = {
        chatroom_id: chatroomId,
        sender: fromUser,
        reciever: toUserObj.id,
        message,
        status: "sent",
        message_type: type,
        editable: type === "text" ? 1 : 0,
        created_at: new Date(),
      };

      const [inserted] = await pool.query(
        `
        INSERT INTO messages (chatroom_id, from_user_id, to_user_id, message, message_type, editable)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [chatroomId, fromUser, toUserObj.id, message, type, msg.editable]
      );
      msg.id = inserted.insertId;

      const toSocketId = users.get(toUserObj.id);
      if (toSocketId) {
        io.to(toSocketId).emit("message:new", msg);
        msg.status = "delivered";
        await pool.query(
          `UPDATE messages SET status = "delivered" 
           WHERE id <= ? AND status = "sent" AND chatroom_id = ?`,
          [msg.id, chatroomId]
        );
        socket.emit("message:delivered", { messageId: msg.id, to });
      } else {
        await sendNotification(toUserObj, msg, fromUser);
      }

      ack?.({ ok: true, message: msg });
    } catch (error) {
      console.error("Error in message:send:", error);
      ack?.({ ok: false, error: "Internal server error" });
    }
  });

  socket.on("message:read", async ({ messageId, reciever, sender, roomId }) => {
    try {
      await pool.query(
        `UPDATE messages 
         SET status = "read" 
         WHERE id <= ? AND to_user_id = ? AND chatroom_id = ? AND status != "read"`,
        [messageId, reciever, roomId]
      );

      const senderSocket = users.get(sender);
      if (senderSocket) {
        io.to(senderSocket).emit("message:read", {
          messageId,
          sender,
        });
      }
    } catch (error) {
      console.error("message:read error:", error);
    }
  });

  socket.on("message:delete", async ({ messageId, roomId: chatroomId, userId }) => {
    try {
      console.log({ messageId, chatroomId, userId })
      // 1️⃣ Update message status in DB
      await pool.query(
        `UPDATE messages SET status = "deleted" WHERE id = ? AND chatroom_id = ?`,
        [messageId, chatroomId]
      );

      // 2️⃣ Notify sender (this socket) and receiver (if online)
      const updatedMessage = {
        id: messageId,
        chatroom_id: chatroomId,
        status: "deleted",
      };

      console.log(updatedMessage)

      // Emit to the sender (self)
      socket.emit("message:deleted", updatedMessage);

      // Find other user in chatroom
      const [chatroom] = await pool.query(
        "SELECT user1_id, user2_id FROM chatrooms WHERE id = ? LIMIT 1",
        [chatroomId]
      );

      if (chatroom.length > 0) {
        const { user1_id, user2_id } = chatroom[0];
        const otherUserId = user1_id === userId ? user2_id : user1_id;
        const otherSocketId = users.get(otherUserId);

        if (otherSocketId) {
          io.to(otherSocketId).emit("message:deleted", updatedMessage);
        }
      }
    } catch (error) {
      console.error("❌ Error deleting message:", error);
      socket.emit("error", { message: "Failed to delete message" });
    }
  });

  socket.on("disconnect", () => {
    const userId = findSocketUserId(socket.id);
    if (userId) {
      users.delete(userId);
      online.delete(userId);
      socket.broadcast.emit("presence:offline", { userId });
      console.log(`❌ User ${userId} disconnected`);
    }
  });

  socket.on("connect_error", (err) => {
    console.error("❌ Socket connect error:", err.message);
  });
});

// ------------------ REST API ROUTE ------------------ //
// app.get("/messages", async (req, res) => {
//   try {
//     const { chatroomId, lastMessageId, limit = 50 } = req.query;

//     let query = `
//       SELECT
//         id,
//         chatroom_id,
//         from_user_id AS sender,
//         to_user_id AS reciever,
//         message,
//         message_type,
//         status,
//         editable,
//         created_at,
//         updated_at
//       FROM messages
//       WHERE chatroom_id = ?
//     `;

//     const params = [chatroomId];

//     if (lastMessageId) {
//       query += " AND id < ?";
//       params.push(lastMessageId);
//     }

//     console.log({ lastMessageId });

//     query += " ORDER BY created_at DESC LIMIT ?";
//     params.push(Number(limit));

//     const [rows] = await pool.query(query, params);
//     console.log(rows[0]);

//     res.json({
//       messages: rows,
//       hasMore: rows.length === Number(limit),
//     });
//   } catch (error) {
//     console.error("❌ Error fetching messages:", error);
//     res.status(500).json({ message: "Internal server error" });
//   }
// });

import { format, isToday, isYesterday } from "date-fns";

app.get("/messages", async (req, res) => {
  try {
    const { chatroomId, lastMessageId, limit = 50 } = req.query;

    // 1️⃣ First query: fetch messages (ordered DESC)
    let messageQuery = `
      SELECT 
        id,
        chatroom_id,
        from_user_id AS sender,
        to_user_id AS reciever,
        message,
        message_type,
        status,
        editable,
        created_at,
        updated_at
      FROM messages
      WHERE chatroom_id = ?
    `;

    const params = [chatroomId];

    if (lastMessageId) {
      messageQuery += " AND id < ?";
      params.push(lastMessageId);
    }

    let newQuery = messageQuery;
    const newParams = [...params];

    messageQuery += " ORDER BY created_at DESC LIMIT ?";
    params.push(Number(limit));

    const [messages] = await pool.query(messageQuery, params);

    if (!messages.length) {
      return res.json({ messages: [], hasMore: false });
    }

    // 2️⃣ Second query: get unique date buckets for those messages
    const [dateGroups] = await pool.query(
      newQuery + "Group By DATE(created_at) ORDER BY created_at DESC",
      newParams
    );

    // 3️⃣ Build final array: interleave headers + messages
    const messageData = [];
    const result = messages.forEach((msg, msgDateKey) => {
      const msgDate = new Date(msg.created_at);
      let header = null;
      if (isToday(msgDate)) {
        header = "Today";
      } else if (isYesterday(msgDate)) {
        header = "Yesterday";
      } else {
        header = format(msgDate, "MMMM dd, yyyy");
      }
      const found = dateGroups.find((dg) => dg.id === msg.id);
      messageData.push(msg);
      if (found) {
        // This message is the first of its date group
        messageData.push({
          id: `header-${msgDateKey}`, // unique id
          header,
        });
      }
    });

    res.json({
      messages: messageData,
      hasMore: messages.length === Number(limit),
    });
  } catch (error) {
    console.error("❌ Error fetching messages:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

httpServer.listen(4000, () => console.log("🚀 Chat service running on :4000"));

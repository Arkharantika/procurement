import {
  processPriceFinder,
  resolveUserChoice,
  cancelSession,
  isSessionActive,
} from "./services/priceFinder.js";

export function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    socket.on("join_session", ({ sessionId }) => {
      if (sessionId) socket.join(sessionId);
    });

    socket.on("start_price_finder", async ({ sessionId, lines }) => {
      if (!sessionId || !Array.isArray(lines)) {
        socket.emit("error_message", {
          message: "sessionId and lines[] are required",
        });
        return;
      }

      // Tanpa guard ini, dua event dengan sessionId sama menjalankan dua loop
      // paralel yang berebut resolver pending yang sama — jawaban user bisa
      // nyasar ke loop yang salah.
      if (isSessionActive(sessionId)) {
        socket.emit("error_message", {
          message: "Session ini sedang berjalan. Tunggu sampai selesai.",
        });
        return;
      }

      socket.join(sessionId);

      try {
        await processPriceFinder(io, sessionId, lines);
      } catch (err) {
        io.to(sessionId).emit("error_message", { message: err.message });
      }
    });

    socket.on("user_choice", ({ sessionId, lineIndex, choice }) => {
      resolveUserChoice(sessionId, lineIndex, choice);
    });

    socket.on("cancel_session", ({ sessionId }) => {
      if (sessionId) cancelSession(sessionId);
    });

    // "disconnecting" (bukan "disconnect") — di sinilah socket.rooms masih terisi,
    // jadi kita masih tahu sesi mana yang ditinggalkan. Sesi hanya dibatalkan
    // kalau ini socket TERAKHIR di room itu, supaya membuka tab kedua lalu
    // menutupnya tidak ikut membunuh proses yang sedang berjalan.
    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room === socket.id) continue;
        if (!isSessionActive(room)) continue;

        const remaining = io.sockets.adapter.rooms.get(room)?.size ?? 0;
        if (remaining <= 1) cancelSession(room);
      }
    });
  });
}

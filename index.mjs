import { Client, GatewayIntentBits, Partials } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from "@discordjs/voice";
import mongoose from "mongoose";
import "dotenv/config";
import fetch from "node-fetch";
import play from "play-dl";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const queue = new Map();

// ✅ MongoDB setup
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

const userSchema = new mongoose.Schema({
  userId: String,
  xp: Number,
  level: Number,
});

const User = mongoose.model("User", userSchema);

// ✅ Bot ready
client.once("ready", () => {
  console.log(`✅ Bot aktif sebagai ${client.user.tag}`);
});

// ✅ Welcome new member
client.on("guildMemberAdd", async (member) => {
  const channel = member.guild.systemChannel;
  if (channel) {
    channel.send(`👋 Selamat datang, ${member.user.username}!`);
  }
  await User.findOneAndUpdate(
    { userId: member.id },
    { $setOnInsert: { xp: 0, level: 1 } },
    { upsert: true, new: true }
  );
});

// ✅ Message create
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // 🔥 Leveling system
  let user = await User.findOne({ userId: message.author.id });
  if (!user) {
    user = await User.create({ userId: message.author.id, xp: 0, level: 1 });
  }
  user.xp += 10;
  if (user.xp >= user.level * 100) {
    user.level += 1;
    user.xp = 0;
    message.reply(`🎉 Selamat ${message.author.username}, kamu naik ke level ${user.level}!`);
  }
  await user.save();

  // 🔥 HELP COMMAND
  if (message.content === "!help") {
    return message.reply(`📜 **Daftar Command:**
- !chat <pesan> ➔ Chat dengan AI
- !radio ➔ Play lofi radio
- !radioindo ➔ Play radio Indonesia
- !play <url_youtube> ➔ Play audio dari YouTube
- !skip ➔ Skip lagu
- !stop ➔ Stop lagu
- !queue ➔ Tampilkan antrian lagu
- !help ➔ Menampilkan command list`);
  }

  // 🔥 AI Chat (mention bot atau !chat)
  if (message.mentions.has(client.user.id) || message.content.startsWith("!chat ")) {
    const prompt = message.content
      .replace(/<@!?(\d+)>/, "")
      .replace("!chat ", "")
      .trim();

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.1-8b-instruct",
          messages: [
            {
              role: "system",
              content: "You are Kugy AI, a cute, supportive, and humble Indonesian assistant. Always reply warmly and motivatively.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });

      const data = await response.json();
      const aiReply = data.choices[0].message.content;

      await message.reply({ content: `<@${message.author.id}> ${aiReply}` });
    } catch (error) {
      console.error(error);
      await message.reply("❌ Gagal menghubungi AI agent.");
    }
  }

  // 🔥 Play Lofi Radio
  if (message.content === "!radio") {
    if (!message.member.voice.channel) {
      return message.reply("❌ Kamu harus join voice channel dulu.");
    }

    const connection = joinVoiceChannel({
      channelId: message.member.voice.channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer();
    const resource = createAudioResource("https://lofi.stream.laut.fm/lofi");

    player.play(resource);
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Playing, () => {
      console.log("🎧 Lofi radio is playing!");
      message.reply("✅ Memutar lofi radio sekarang!");
    });

    player.on("error", (error) => {
      console.error(error);
      message.reply("❌ Gagal memutar radio.");
    });
  }

  // 🔥 Play Radio Indonesia
  if (message.content === "!radioindo") {
    if (!message.member.voice.channel) {
      return message.reply("❌ Kamu harus join voice channel dulu.");
    }

    const connection = joinVoiceChannel({
      channelId: message.member.voice.channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer();
    const resource = createAudioResource("https://radione.top:8888/dmi");

    player.play(resource);
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Playing, () => {
      console.log("🎧 Radio Indonesia is playing!");
      message.reply("✅ Memutar radio Indonesia sekarang!");
    });

    player.on("error", (error) => {
      console.error(error);
      message.reply("❌ Gagal memutar radio Indonesia.");
    });
  }

  // 🔥 Play YouTube Audio
  if (message.content.startsWith("!play ")) {
    const serverQueue = queue.get(message.guild.id);

    if (!message.member.voice.channel) {
      return message.reply("❌ Kamu harus join voice channel dulu.");
    }

    const url = message.content.split(" ")[1];

    if (!play.yt_validate(url)) {
      return message.reply("❌ URL YouTube tidak valid.");
    }

    const songInfo = await play.search(url, { limit: 1 });
    const song = {
      title: songInfo[0].title,
      url: songInfo[0].url,
      duration: songInfo[0].duration,
    };

    if (!serverQueue) {
      const queueContruct = {
        textChannel: message.channel,
        voiceChannel: message.member.voice.channel,
        connection: null,
        songs: [],
        volume: 5,
        playing: true,
      };

      queue.set(message.guild.id, queueContruct);
      queueContruct.songs.push(song);

      try {
        const connection = joinVoiceChannel({
          channelId: message.member.voice.channel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
        });
        queueContruct.connection = connection;
        playSong(message.guild.id, queueContruct.songs[0]);
      } catch (err) {
        console.log(err);
        queue.delete(message.guild.id);
        return message.channel.send(err);
      }
    } else {
      serverQueue.songs.push(song);
      return message.channel.send(`✅ **${song.title}** ditambahkan ke antrian!`);
    }
  } else if (message.content.startsWith("!skip")) {
    skip(message);
    return;
  } else if (message.content.startsWith("!stop")) {
    stop(message);
    return;
  } else if (message.content.startsWith("!queue")) {
    displayQueue(message);
    return;
  }
});

function playSong(guildId, song) {
  const serverQueue = queue.get(guildId);
  if (!song) {
    serverQueue.voiceChannel.leave();
    queue.delete(guildId);
    return;
  }

  const player = createAudioPlayer();
  play.stream(song.url).then(stream => {
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
    });
    player.play(resource);
    serverQueue.connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      serverQueue.songs.shift();
      playSong(guildId, serverQueue.songs[0]);
    });

    player.on("error", error => {
      console.error(error);
    });

    serverQueue.textChannel.send(`🎶 Memutar: **${song.title}** - Durasi: ${song.duration}`);
  })
}

function skip(message) {
  const serverQueue = queue.get(message.guild.id);
  if (!message.member.voice.channel)
    return message.channel.send(
      "❌ Kamu harus join voice channel dulu untuk skip lagu!"
    );
  if (!serverQueue)
    return message.channel.send("❌ Tidak ada lagu yang bisa di-skip!");

  const player = serverQueue.connection.state.subscription.player;
  player.stop();
}

function stop(message) {
  const serverQueue = queue.get(message.guild.id);
  if (!message.member.voice.channel)
    return message.channel.send(
      "❌ Kamu harus join voice channel dulu untuk stop lagu!"
    );
  serverQueue.songs = [];
  const player = serverQueue.connection.state.subscription.player;
  player.stop();
}

function displayQueue(message) {
  const serverQueue = queue.get(message.guild.id);
  if (!serverQueue) return message.channel.send("❌ Antrian kosong!");
  let queueMessage = "📜 **Antrian Lagu:**\n";
  serverQueue.songs.forEach((song, index) => {
    queueMessage += `${index + 1}. ${song.title}\n`;
  });
  return message.channel.send(queueMessage);
}

client.login(process.env.DISCORD_TOKEN);

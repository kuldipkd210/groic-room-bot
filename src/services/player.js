const { emit } = require("../socket");
const { getSpotifyTracks } = require("./spotify");
const { resolveTrackToYouTube, toGroicPlaylistItem, findCachedTrackByVideoId } = require("./youtube");

class MusicPlayer {
  constructor() {
    this.roomUid = null;
    this.playlist = [];
    this.playlistName = "";
    this.currentIndex = -1;
    this.currentSong = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.isLooping = true; // Loop playlist by default

    this.autoAdvanceTimer = null;
    this.playbackStartTime = null;
    this.pauseStartTime = null;
    this.pausedElapsedSeconds = 0;

    // Cache of resolved YouTube tracks for this playlist: index -> GroicSong
    this.resolvedCache = new Map();
    this.chatNotifyCallback = null;
  }

  setRoomUid(roomUid) {
    this.roomUid = roomUid;
  }

  setChatNotifier(callback) {
    this.chatNotifyCallback = callback;
  }

  notifyChat(message) {
    if (this.chatNotifyCallback && this.roomUid) {
      try {
        this.chatNotifyCallback(message, this.roomUid);
      } catch (err) {
        console.error("[MusicPlayer] Failed to send chat notification:", err.message);
      }
    }
  }

  /**
   * Loads a Spotify playlist/album and optionally starts playback immediately.
   */
  async loadSpotifyPlaylist(input, options = { autoPlay: true, shuffle: true }) {
    console.log(`[MusicPlayer] Loading Spotify playlist: ${input}`);
    const data = await getSpotifyTracks(input);

    if (!data.tracks || data.tracks.length === 0) {
      throw new Error("No tracks found in the provided Spotify link.");
    }

    this.clearAdvanceTimer();
    let tracks = [...data.tracks];

    // Automatically shuffle tracks before loading
    if (options.shuffle !== false && tracks.length > 1) {
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }
      console.log(`[MusicPlayer] Shuffled ${tracks.length} tracks before loading.`);
    }

    this.playlist = tracks;
    this.playlistName = data.name || "Spotify Playlist";
    this.currentIndex = 0;
    this.resolvedCache.clear();
    this.isPaused = false;

    console.log(`[MusicPlayer] Loaded "${this.playlistName}" with ${this.playlist.length} tracks.`);

    if (options.autoPlay) {
      const firstSong = await this.playIndex(0);
      this.resolveAllInBackground();
      return firstSong;
    }

    this.resolveAllInBackground();
    return {
      playlistName: this.playlistName,
      trackCount: this.playlist.length
    };
  }

  /**
   * Plays a track at the given index in the playlist.
   */
  async playIndex(index) {
    if (index < 0 || index >= this.playlist.length) {
      if (this.isLooping && this.playlist.length > 0) {
        index = 0;
      } else {
        this.stop();
        this.notifyChat("Playlist has reached the end.");
        return null;
      }
    }

    this.currentIndex = index;
    const spotifyTrack = this.playlist[index];

    let song = this.resolvedCache.get(index);
    if (!song) {
      song = await resolveTrackToYouTube(spotifyTrack);
      if (song) {
        this.resolvedCache.set(index, song);
      }
    }

    if (!song) {
      console.warn(`[MusicPlayer] Could not resolve track ${index} (${spotifyTrack.title}), skipping...`);
      return await this.next();
    }

    this.currentSong = song;
    this.isPlaying = true;
    this.isPaused = false;
    this.playbackStartTime = Date.now();
    this.pausedElapsedSeconds = 0;

    // 1. Emit playSong to Groic room
    console.log(`[MusicPlayer] Emitting playSong: "${song.title}" (${song.songurl})`);
    emit("playSong", song);

    // 2. Build and emit room playlist so UI queue stays updated
    this.emitRoomPlaylist();

    // 3. Setup auto-advance timer based on track duration
    this.scheduleAutoAdvance(song.duration || spotifyTrack.durationSec || 200);

    return song;
  }

  /**
   * Schedules advancing to the next track when duration expires.
   */
  scheduleAutoAdvance(durationSeconds) {
    this.clearAdvanceTimer();

    // Give a 2-second grace period after duration completes
    const timeoutMs = Math.max(10, durationSeconds + 2) * 1000;
    console.log(`[MusicPlayer] Auto-advance scheduled in ${Math.round(timeoutMs / 1000)}s`);

    this.autoAdvanceTimer = setTimeout(async () => {
      console.log(`[MusicPlayer] Track ended. Auto-advancing to next track...`);
      const nextSong = await this.next();
      if (nextSong) {
        this.notifyChat(`Now Playing: "${nextSong.title}" by ${nextSong.artist}`);
      }
    }, timeoutMs);
  }

  clearAdvanceTimer() {
    if (this.autoAdvanceTimer) {
      clearTimeout(this.autoAdvanceTimer);
      this.autoAdvanceTimer = null;
    }
  }

  /**
   * Fast background resolver for the entire playlist in batches.
   * Emits updated room playlist after each batch resolves so only verified,
   * working YouTube tracks appear in Groic.
   */
  async resolveAllInBackground() {
    if (this.isResolvingPlaylist) return;
    this.isResolvingPlaylist = true;

    try {
      const total = this.playlist.length;
      const batchSize = 5;

      for (let i = 0; i < total; i += batchSize) {
        if (!this.isPlaying && this.playlist.length === 0) break;

        const promises = [];
        for (let j = i; j < Math.min(total, i + batchSize); j++) {
          if (!this.resolvedCache.has(j) && this.playlist[j]) {
            const track = this.playlist[j];
            promises.push(
              resolveTrackToYouTube(track).then((res) => {
                if (res) this.resolvedCache.set(j, res);
              })
            );
          }
        }

        if (promises.length > 0) {
          await Promise.all(promises);
          this.emitRoomPlaylist();
          await new Promise((r) => setTimeout(r, 60));
        }
      }
    } catch (err) {
      console.warn("[MusicPlayer] Background playlist resolution error:", err.message);
    } finally {
      this.isResolvingPlaylist = false;
      this.emitRoomPlaylist();
    }
  }

  /**
   * Emits the sendPlaylist event to Groic room with ONLY verified, playable songs.
   * NEVER sends pending_ fake IDs to prevent "Video unavailable" errors in Groic!
   */
  emitRoomPlaylist() {
    if (!this.playlist || this.playlist.length === 0) return;

    const songs = [];
    const maxItems = Math.min(this.playlist.length, 100);

    for (let i = 0; i < maxItems; i++) {
      const idx = (this.currentIndex + i) % this.playlist.length;
      const resolved = this.resolvedCache.get(idx);

      if (resolved && resolved.songurl && !resolved.songurl.startsWith("pending_")) {
        songs.push(toGroicPlaylistItem(resolved, i === 0));
      }
    }

    if (songs.length > 0) {
      console.log(`[MusicPlayer] Emitting playlist to room (${songs.length} verified playable tracks)`);
      emit("sendPlaylist", { songs });
    }
  }

  /**
   * Skip to the next track.
   */
  async next() {
    if (this.playlist.length === 0) return null;
    let nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.playlist.length) {
      if (this.isLooping) nextIndex = 0;
      else {
        this.stop();
        return null;
      }
    }
    return await this.playIndex(nextIndex);
  }

  /**
   * Shuffles upcoming tracks in active playlist.
   */
  shuffle() {
    if (!this.playlist || this.playlist.length <= 1) return false;

    const remaining = this.playlist.slice(this.currentIndex + 1);
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    this.playlist = [
      ...this.playlist.slice(0, this.currentIndex + 1),
      ...remaining
    ];

    this.resolvedCache.clear();
    if (this.currentSong && this.currentIndex >= 0) {
      this.resolvedCache.set(this.currentIndex, this.currentSong);
    }

    this.resolveAllInBackground();
    return true;
  }

  /**
   * Stops playback and clears playlist queue.
   */
  stop() {
    this.clearAdvanceTimer();
    this.isPlaying = false;
    this.isPaused = false;
    this.currentSong = null;
    this.playlist = [];
    this.currentIndex = -1;
    this.resolvedCache.clear();

    console.log("[MusicPlayer] Playback stopped");
    emit("playbackAction", 0);
  }

  /**
   * Checks if an incoming song corresponds to an item in the active playlist.
   * Compares:
   * 1. Extracted video ID in resolvedCache
   * 2. Extracted video ID in YouTube trackCache
   * 3. Normalized title and artist match against playlist tracks
   */
  findTrackIndexInPlaylist(data) {
    if (!this.playlist || this.playlist.length === 0 || !data) return -1;

    const incomingUrl = (data.songurl || "").trim();
    const incomingMatch = incomingUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    const incomingVideoId = incomingMatch ? incomingMatch[1] : (incomingUrl.length === 11 ? incomingUrl : incomingUrl);

    const cleanIncomingTitle = (data.title || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
    const cleanIncomingArtist = (data.artist || "").toLowerCase().replace(/[^\w\s]/g, "").trim();

    // 1. Direct check in resolvedCache
    for (const [idx, song] of this.resolvedCache.entries()) {
      if (!song) continue;
      const cachedVideoId = (song.songurl || "").match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/)?.[1] || song.songurl;
      if (incomingVideoId && cachedVideoId && incomingVideoId === cachedVideoId) {
        return idx;
      }
    }

    // 2. Check in YouTube trackCache
    const fromYtCache = findCachedTrackByVideoId(incomingUrl);
    if (fromYtCache) {
      const ytTitle = (fromYtCache.title || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
      for (let i = 0; i < this.playlist.length; i++) {
        const item = this.playlist[i];
        const pTitle = (item.title || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
        if (pTitle && ytTitle && (pTitle.includes(ytTitle) || ytTitle.includes(pTitle))) {
          return i;
        }
      }
    }

    // 3. Match by Title & Artist against playlist items
    if (cleanIncomingTitle) {
      for (let i = 0; i < this.playlist.length; i++) {
        const item = this.playlist[i];
        const pTitle = (item.title || "").toLowerCase().replace(/[^\w\s]/g, "").trim();
        const pArtist = (item.artist || "").toLowerCase().replace(/[^\w\s]/g, "").trim();

        if (pTitle === cleanIncomingTitle || (pTitle.length > 5 && cleanIncomingTitle.includes(pTitle)) || (cleanIncomingTitle.length > 5 && pTitle.includes(cleanIncomingTitle))) {
          if (!cleanIncomingArtist || !pArtist || cleanIncomingArtist.includes(pArtist) || pArtist.includes(cleanIncomingArtist)) {
            return i;
          }
        }
      }
    }

    return -1;
  }

  /**
   * Hook for external room socket events (playbackUpdate).
   */
  handlePlaybackUpdate(data) {
    if (!data) return;

    // Handle Pause
    if (data.action === 0) {
      this.isPaused = true;
      this.clearAdvanceTimer();
      console.log("[MusicPlayer] Playback paused in room.");
      return;
    }

    // Handle Resume
    if (data.action === 1 && this.isPaused) {
      this.isPaused = false;
      console.log("[MusicPlayer] Playback resumed in room.");
      if (this.currentSong && this.isPlaying) {
        const totalDuration = this.currentSong.duration || 200;
        const currentPosSec = typeof data.currentTime === "number" && data.currentTime > 0 ? data.currentTime : 0;
        const remainingSec = Math.max(5, totalDuration - currentPosSec);
        this.scheduleAutoAdvance(remainingSec);
      }
    }

    // If a different song is playing in the room, track it
    if (data.songurl && (!this.currentSong || this.currentSong.songurl !== data.songurl)) {
      console.log(`[MusicPlayer] Song change detected in room: "${data.title}" (${data.songurl})`);

      const matchedIdx = this.findTrackIndexInPlaylist(data);

      if (matchedIdx !== -1) {
        // The song was selected from the active playlist queue!
        console.log(`[MusicPlayer] Song from playlist queue selected: track ${matchedIdx + 1}/${this.playlist.length} ("${this.playlist[matchedIdx].title}"). Continuing playlist monitoring!`);
        this.currentIndex = matchedIdx;

        let song = this.resolvedCache.get(matchedIdx);
        if (!song) {
          song = {
            songurl: data.songurl,
            title: data.title || this.playlist[matchedIdx].title,
            artist: data.artist || this.playlist[matchedIdx].artist,
            duration: data.duration || this.playlist[matchedIdx].durationSec || 200,
            imageurl: data.imageurl || "",
            imageurlhigh: data.imageurlhigh || "",
            youtubePlayer: true,
            action: 1
          };
          this.resolvedCache.set(matchedIdx, song);
        }

        this.currentSong = song;
        this.isPlaying = true;
        this.isPaused = false;
        this.playbackStartTime = Date.now();
        this.pausedElapsedSeconds = 0;

        const durationSec = data.duration || song.duration || this.playlist[matchedIdx].durationSec || 200;
        const currentPosSec = (typeof data.currentTime === "number" && data.currentTime > 0) ? data.currentTime : 0;
        const remainingSec = Math.max(10, durationSec - currentPosSec);

        // Continue playing: schedule auto-advancing to the next song in the playlist when this ends
        this.scheduleAutoAdvance(remainingSec);

        // Keep room UP NEXT queue synced from this new track
        this.emitRoomPlaylist();
        return;
      }

      // The song is NOT part of the playlist (someone searched and played a separate song)
      console.log(`[MusicPlayer] External song NOT in playlist detected: "${data.title}". Stopping playlist monitoring.`);
      this.clearAdvanceTimer();
      this.isPlaying = false;
      this.currentSong = {
        songurl: data.songurl,
        title: data.title || "External Track",
        artist: data.artist || "Unknown",
        imageurl: data.imageurl || "",
        imageurlhigh: data.imageurlhigh || "",
        youtubePlayer: true,
        action: data.action !== undefined ? data.action : 1
      };
    }
  }
}

// Singleton instance
const player = new MusicPlayer();

module.exports = player;

const { emit } = require("../socket");
const { getSpotifyTracks } = require("./spotify");
const { resolveTrackToYouTube, toGroicPlaylistItem } = require("./youtube");

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
      console.log(`[MusicPlayer] 🔀 Shuffled ${tracks.length} tracks before loading.`);
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
        this.notifyChat("🎵 Playlist has reached the end.");
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
        this.notifyChat(`🎶 Now Playing: "${nextSong.title}" by ${nextSong.artist}`);
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
    const wasPlaying = this.isPlaying;
    this.isPlaying = false;
    this.isPaused = false;
    this.currentSong = null;
    this.playlist = [];
    this.currentIndex = -1;
    this.resolvedCache.clear();

    if (wasPlaying) {
      console.log("[MusicPlayer] Playback stopped and queue cleared");
      emit("playbackAction", 0);
    }
  }

  /**
   * Hook for external room socket events (playbackUpdate).
   */
  handlePlaybackUpdate(data) {
    if (!data) return;

    if (data.action === 0) {
      this.isPaused = true;
      this.clearAdvanceTimer();
    } else if (data.action === 1) {
      this.isPaused = false;
    }

    // If a different song is playing in the room, track it
    if (data.songurl && (!this.currentSong || this.currentSong.songurl !== data.songurl)) {
      console.log(`[MusicPlayer] External playback change detected: "${data.title}" (${data.songurl})`);

      // Check if this song corresponds to an item in our current playlist queue
      const matchedIdx = this.playlist.findIndex((t, idx) => {
        const r = this.resolvedCache.get(idx);
        return r && r.songurl === data.songurl;
      });

      if (matchedIdx !== -1) {
        console.log(`[MusicPlayer] User clicked track ${matchedIdx + 1} in queue: "${this.playlist[matchedIdx].title}"`);
        this.currentIndex = matchedIdx;
        this.currentSong = this.resolvedCache.get(matchedIdx);
        this.isPlaying = true;
        this.isPaused = false;
        this.playbackStartTime = Date.now();
        this.pausedElapsedSeconds = 0;
        this.scheduleAutoAdvance(this.currentSong.duration || 200);
        return;
      }

      this.currentSong = {
        songurl: data.songurl,
        title: data.title || "Track",
        artist: data.artist || "Unknown",
        imageurl: data.imageurl || "",
        imageurlhigh: data.imageurlhigh || "",
        youtubePlayer: true,
        action: data.action !== undefined ? data.action : 1
      };
      this.isPlaying = true;
      // Do not fight with external playback; if duration unknown, don't force auto-advance
      this.clearAdvanceTimer();
    }
  }
}

// Singleton instance
const player = new MusicPlayer();

module.exports = player;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ConversationMemory } = require('./conversation-memory');

class ChatManager {
  constructor(indexDir, userId, feedbackIndex) {
    this._userId = userId || '_anonymous';
    this._feedbackIndex = feedbackIndex;

    if (this._userId && this._userId !== '_anonymous') {
      this._dir = path.join(indexDir, 'users', this._userId);
    } else {
      this._dir = indexDir;
    }

    this._metaFile = path.join(this._dir, 'chats.json');
    this._meta = { chats: [], activeChatId: null };
    this._memoryCache = new Map();
  }

  load() {
    if (!fs.existsSync(this._dir)) fs.mkdirSync(this._dir, { recursive: true });

    if (fs.existsSync(this._metaFile)) {
      try {
        this._meta = JSON.parse(fs.readFileSync(this._metaFile, 'utf-8'));
      } catch (e) {
        console.log(`  Chat meta load error: ${e.message}`);
        this._meta = { chats: [], activeChatId: null };
      }
    } else {
      this._migrateLegacy();
    }

    // Ensure there's always at least one chat
    if (this._meta.chats.length === 0) {
      this.createChat();
    }

    // Ensure activeChatId points to a valid chat
    const ids = new Set(this._meta.chats.map(c => c.id));
    if (!this._meta.activeChatId || !ids.has(this._meta.activeChatId)) {
      this._meta.activeChatId = this._meta.chats[0].id;
      this.save();
    }
  }

  save() {
    if (!fs.existsSync(this._dir)) fs.mkdirSync(this._dir, { recursive: true });
    fs.writeFileSync(this._metaFile, JSON.stringify(this._meta, null, 2));
  }

  _migrateLegacy() {
    const legacyFile = path.join(this._dir, 'memory.json');
    if (!fs.existsSync(legacyFile)) return;

    try {
      const data = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
      const firstQuery = (data.memories && data.memories[0] && data.memories[0].query) || '';
      const firstTimestamp = (data.memories && data.memories[0] && data.memories[0].timestamp) || new Date().toISOString();

      const chatId = 'chat-' + Date.now();
      const title = firstQuery
        ? (firstQuery.length > 50 ? firstQuery.slice(0, 50).replace(/\s+\S*$/, '') + '...' : firstQuery)
        : 'Imported Chat';

      const chatFile = path.join(this._dir, `chat-${chatId}.json`);
      fs.renameSync(legacyFile, chatFile);

      this._meta = {
        chats: [{
          id: chatId,
          title,
          createdAt: firstTimestamp,
          lastActivityAt: new Date().toISOString(),
        }],
        activeChatId: chatId,
      };
      this.save();
      console.log(`  Migrated legacy memory.json → chat ${chatId}`);
    } catch (e) {
      console.log(`  Legacy migration error: ${e.message}`);
    }
  }

  listChats() {
    return [...this._meta.chats].sort(
      (a, b) => new Date(b.lastActivityAt || b.createdAt) - new Date(a.lastActivityAt || a.createdAt)
    );
  }

  createChat() {
    const chat = {
      id: 'chat-' + crypto.randomUUID().slice(0, 12),
      title: '',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this._meta.chats.push(chat);
    this._meta.activeChatId = chat.id;
    this.save();
    return chat;
  }

  deleteChat(chatId) {
    // Validate chatId format to prevent path traversal
    if (!/^chat-[\w-]+$/.test(chatId)) return false;

    const idx = this._meta.chats.findIndex(c => c.id === chatId);
    if (idx === -1) return false;

    this._meta.chats.splice(idx, 1);
    this._memoryCache.delete(chatId);

    // Delete the file
    const chatFile = path.join(this._dir, `chat-${chatId}.json`);
    if (fs.existsSync(chatFile)) {
      try { fs.unlinkSync(chatFile); } catch (e) { /* ignore */ }
    }

    // If we deleted the active chat, switch to most recent or create new
    if (this._meta.activeChatId === chatId) {
      if (this._meta.chats.length > 0) {
        const sorted = this.listChats();
        this._meta.activeChatId = sorted[0].id;
      } else {
        const newChat = this.createChat();
        this._meta.activeChatId = newChat.id;
      }
    }

    this.save();
    return true;
  }

  getActiveChatId() {
    return this._meta.activeChatId;
  }

  setActiveChatId(chatId) {
    const chat = this._meta.chats.find(c => c.id === chatId);
    if (!chat) return false;
    this._meta.activeChatId = chatId;
    this.save();
    return true;
  }

  getMemory(chatId) {
    if (this._memoryCache.has(chatId)) return this._memoryCache.get(chatId);

    const chatFile = path.join(this._dir, `chat-${chatId}.json`);
    const mem = new ConversationMemory(null, {
      userId: this._userId,
      feedbackIndex: this._feedbackIndex,
      memoryFile: chatFile,
    });
    mem.load();
    this._memoryCache.set(chatId, mem);
    return mem;
  }

  getActiveMemory() {
    return this.getMemory(this._meta.activeChatId);
  }

  autoTitle(chatId, query) {
    const chat = this._meta.chats.find(c => c.id === chatId);
    if (!chat || chat.title) return;

    let title = query.trim();
    if (title.length > 50) {
      title = title.slice(0, 50).replace(/\s+\S*$/, '') + '...';
    }
    chat.title = title;
    this.save();
  }

  renameChat(chatId, title) {
    const chat = this._meta.chats.find(c => c.id === chatId);
    if (!chat) return false;
    chat.title = title;
    this.save();
    return true;
  }

  touchChat(chatId) {
    const chat = this._meta.chats.find(c => c.id === chatId);
    if (chat) {
      chat.lastActivityAt = new Date().toISOString();
      this.save();
    }
  }
}

module.exports = { ChatManager };

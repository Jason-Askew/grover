const crypto = require('crypto');
const db = require('../persistence/db');
const { ConversationMemory } = require('./conversation-memory');

class ChatManager {
  constructor(indexName, userId, feedbackIndex) {
    this._indexName = indexName;
    this._userId = userId || '_anonymous';
    this._feedbackIndex = feedbackIndex;
    this._activeChatId = null;
    this._memoryCache = new Map();
  }

  async load() {
    // Ensure there's always at least one chat
    const { rows } = await db.query(
      'SELECT id FROM chats WHERE index_name = $1 AND user_id = $2 LIMIT 1',
      [this._indexName, this._userId]
    );

    if (rows.length === 0) {
      await this.createChat();
    }

    // Set active chat: prefer the one marked active, else most recent
    const activeRes = await db.query(
      'SELECT id FROM chats WHERE index_name = $1 AND user_id = $2 AND is_active = true LIMIT 1',
      [this._indexName, this._userId]
    );

    if (activeRes.rows.length > 0) {
      this._activeChatId = activeRes.rows[0].id;
    } else {
      const recentRes = await db.query(
        'SELECT id FROM chats WHERE index_name = $1 AND user_id = $2 ORDER BY last_activity_at DESC LIMIT 1',
        [this._indexName, this._userId]
      );
      if (recentRes.rows.length > 0) {
        this._activeChatId = recentRes.rows[0].id;
        await db.query(
          'UPDATE chats SET is_active = true WHERE id = $1',
          [this._activeChatId]
        );
      }
    }
  }

  async listChats() {
    const { rows } = await db.query(
      `SELECT id, title, created_at, last_activity_at
       FROM chats WHERE index_name = $1 AND user_id = $2
       ORDER BY last_activity_at DESC`,
      [this._indexName, this._userId]
    );
    return rows.map(r => ({
      id: r.id,
      title: r.title || '',
      createdAt: r.created_at.toISOString(),
      lastActivityAt: r.last_activity_at.toISOString(),
    }));
  }

  async createChat() {
    const id = 'chat-' + crypto.randomUUID().slice(0, 12);
    const now = new Date();

    // Deactivate current active chat
    await db.query(
      'UPDATE chats SET is_active = false WHERE index_name = $1 AND user_id = $2 AND is_active = true',
      [this._indexName, this._userId]
    );

    await db.query(
      `INSERT INTO chats (id, index_name, user_id, title, created_at, last_activity_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [id, this._indexName, this._userId, '', now, now]
    );

    this._activeChatId = id;
    return { id, title: '', createdAt: now.toISOString(), lastActivityAt: now.toISOString() };
  }

  async deleteChat(chatId) {
    // Validate chatId format to prevent injection
    if (!/^chat-[\w-]+$/.test(chatId)) return false;

    const { rowCount } = await db.query(
      'DELETE FROM chats WHERE id = $1 AND index_name = $2 AND user_id = $3',
      [chatId, this._indexName, this._userId]
    );
    if (rowCount === 0) return false;

    this._memoryCache.delete(chatId);

    // If we deleted the active chat, switch to most recent or create new
    if (this._activeChatId === chatId) {
      const { rows } = await db.query(
        'SELECT id FROM chats WHERE index_name = $1 AND user_id = $2 ORDER BY last_activity_at DESC LIMIT 1',
        [this._indexName, this._userId]
      );
      if (rows.length > 0) {
        this._activeChatId = rows[0].id;
        await db.query('UPDATE chats SET is_active = true WHERE id = $1', [this._activeChatId]);
      } else {
        const newChat = await this.createChat();
        this._activeChatId = newChat.id;
      }
    }

    return true;
  }

  getActiveChatId() {
    return this._activeChatId;
  }

  async setActiveChatId(chatId) {
    const { rowCount } = await db.query(
      'SELECT 1 FROM chats WHERE id = $1 AND index_name = $2 AND user_id = $3',
      [chatId, this._indexName, this._userId]
    );
    if (rowCount === 0) {
      // Verify the chat actually exists
      const check = await db.query('SELECT 1 FROM chats WHERE id = $1', [chatId]);
      if (check.rows.length === 0) return false;
    }

    await db.query(
      'UPDATE chats SET is_active = false WHERE index_name = $1 AND user_id = $2 AND is_active = true',
      [this._indexName, this._userId]
    );
    await db.query('UPDATE chats SET is_active = true WHERE id = $1', [chatId]);
    this._activeChatId = chatId;
    return true;
  }

  getMemory(chatId) {
    if (this._memoryCache.has(chatId)) return this._memoryCache.get(chatId);

    const mem = new ConversationMemory(chatId, {
      userId: this._userId,
      feedbackIndex: this._feedbackIndex,
    });
    this._memoryCache.set(chatId, mem);
    return mem;
  }

  getActiveMemory() {
    return this.getMemory(this._activeChatId);
  }

  async autoTitle(chatId, query) {
    const { rows } = await db.query('SELECT title FROM chats WHERE id = $1', [chatId]);
    if (rows.length === 0 || rows[0].title) return;

    let title = query.trim();
    if (title.length > 50) {
      title = title.slice(0, 50).replace(/\s+\S*$/, '') + '...';
    }
    await db.query('UPDATE chats SET title = $1 WHERE id = $2', [title, chatId]);
  }

  async renameChat(chatId, title) {
    const { rowCount } = await db.query(
      'UPDATE chats SET title = $1 WHERE id = $2 AND index_name = $3 AND user_id = $4',
      [title, chatId, this._indexName, this._userId]
    );
    return rowCount > 0;
  }

  async touchChat(chatId) {
    await db.query(
      'UPDATE chats SET last_activity_at = NOW() WHERE id = $1',
      [chatId]
    );
  }
}

module.exports = { ChatManager };

-- 003_drop_memory.sql — 移除记忆功能（M4 用户记忆 + FTS5 全文检索）
-- 决策（2026-08-17）：记忆改由 AstrBot 提示词/人设约定 + 工作区文件存储，后端不再持久化。
-- 002 用 trigram 重建过 user_memories_fts；FTS 为独立虚拟表（无外键），先删 FTS 再删主表，
-- 均 IF EXISTS 兜底。勿改已应用的 001/002。
DROP TABLE IF EXISTS user_memories_fts;
DROP TABLE IF EXISTS user_memories;

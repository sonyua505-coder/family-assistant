-- 002_memory_fts_trigram.sql
-- 用户记忆全文检索改用 trigram 分词器（M4）。
-- 理由：默认 unicode61 把整段连续中文当成一个 token，"买菜"搜不到"今天买菜花了50"；
--       trigram 支持子串匹配（含中文），≥3 字符的查询即可命中。
DROP TABLE IF EXISTS user_memories_fts;
CREATE VIRTUAL TABLE user_memories_fts USING fts5(person_id UNINDEXED, content, tokenize='trigram');

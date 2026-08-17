-- 004_drop_profile.sql — 移除画像功能（persons.profile_text 列）
-- 决策（2026-08-18）：与记忆一致，画像交给用户工作区文件自由组织，后端不再持久化。
-- persons 无 profile 相关索引/触发器/视图引用，DROP COLUMN 安全（SQLite ≥ 3.35）。勿改已应用的 001。
ALTER TABLE persons DROP COLUMN profile_text;

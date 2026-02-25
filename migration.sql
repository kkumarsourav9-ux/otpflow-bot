-- Migration: Add multi-instance rotation columns to whatsapp_instances
-- Run this SQL in your phpMyAdmin on InfinityFree

ALTER TABLE whatsapp_instances
  ADD COLUMN IF NOT EXISTS daily_message_limit INT DEFAULT 50,
  ADD COLUMN IF NOT EXISTS messages_sent_today INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reset_date DATE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_banned TINYINT(1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS priority INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS auth_creds JSON DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS auth_keys JSON DEFAULT NULL;

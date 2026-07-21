-- 各キャラのオリジナル動画(lp-hero)から複数フレームを抽出しdHash計算して登録。
-- INSERT OR REPLACEなので再実行しても安全（(phash, hash_kind)がPRIMARY KEY）。
-- source='seed_original': ローカルのオリジナルmp4ファイルから直接抽出。
-- source='harvest_line'  : 実機でLINE経由(送信→再エンコード→previewAPI)で
--                           観測された実測ハッシュ（2026-07-21 [phash-observe]ログより）。
INSERT OR REPLACE INTO bot_media_phash (phash, hash_kind, character, kind, source) VALUES
  ('a4929098cadee824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('64929098cade7824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('649290d8cadef824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('6492909c8ede6824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('a49290d8cade6824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('a49290d8cadee824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('a492909ccadee824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('6492909ccade6824', 'dhash_9x8', 'こん太', 'lp-hero', 'seed_original'),
  ('d2f0eabc9ebe9e24', 'dhash_9x8', 'りんく', 'lp-hero', 'seed_original'),
  ('d2f0eabc9e9e9e25', 'dhash_9x8', 'りんく', 'lp-hero', 'seed_original'),
  ('d2f0eabc9eae9e24', 'dhash_9x8', 'りんく', 'lp-hero', 'seed_original'),
  ('d2f0eabc9e9e9e24', 'dhash_9x8', 'りんく', 'lp-hero', 'seed_original'),
  ('c6d4c8848e96c455', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('c6d4c8c48e96c442', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('c6d4c8848e96c441', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('c6d4c8848e96c421', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('ced4c8848e96c421', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('c6d4c8848e96c453', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('c6d4c8c48e86cc42', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('c6d4c8c48e86cc45', 'dhash_9x8', 'たぬ姉', 'lp-hero', 'seed_original'),
  ('d6d4c8c48e96c4c2', 'dhash_9x8', 'たぬ姉', 'bot-test', 'harvest_line');

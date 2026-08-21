-- アカウント単位の既定プロジェクト。NULL = 既存動作のまま（ref_codeベースの
-- resolveBotProjectのみで解決、無ければbot.config.jsonのdefaultProjectへ）。
-- 友だちがref_codeを経由せず直接アカウントを追加した場合の受け皿として、
-- 「このLINE公式アカウントに来た人は既定でこのプロジェクトの人格を使う」を
-- アカウント単位で設定できるようにする（例: @871xstqyは常にyukkuri-exosome）。
ALTER TABLE line_accounts ADD COLUMN default_project TEXT;

-- 地籍共作平台：在三個所共用的 PostgreSQL 裡隔出自己的一塊（schema）
-- 由資料庫管理者（有建立角色權限的帳號）在 psql 或 pgAdmin 執行。
-- ⚠ 密碼請自己設新的，不要寫進 QGIS 專案檔或任何會發給別人的檔案。

-- 1. 平台專用帳號（只能動自己的 schema）
CREATE ROLE kc_cowork_app LOGIN PASSWORD '請改成新的強密碼';
CREATE SCHEMA kc_cowork AUTHORIZATION kc_cowork_app;
REVOKE ALL ON SCHEMA kc_cowork FROM PUBLIC;

-- 2. 平台只「讀」現有的圖根點清查表，不能改別人的資料
GRANT USAGE ON SCHEMA public TO kc_cowork_app;
GRANT SELECT ON public.n_kc_ctl, public.kc_ct2, public.kc_ctl_n TO kc_cowork_app;

-- 3. 給外面查詢（QGIS、網頁）用的唯讀帳號：只看得到 kc_cowork
CREATE ROLE kc_cowork_ro LOGIN PASSWORD '請改成另一組新密碼';
GRANT USAGE ON SCHEMA kc_cowork TO kc_cowork_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE kc_cowork_app IN SCHEMA kc_cowork GRANT SELECT ON TABLES TO kc_cowork_ro;

-- 4. 平台要放的表（以 kc_cowork_app 身分建立）
SET ROLE kc_cowork_app;
CREATE TABLE kc_cowork.controls (           -- 圖根點（整理後、全部 TWD97）
  id text PRIMARY KEY, name text NOT NULL, sections text[], y97 double precision, x97 double precision,
  datum_src text, survey_state text, survey_label text, survey_time text, survey_ps text,
  geom geometry(Point, 3826)
);
CREATE TABLE kc_cowork.supp_points (        -- 補點清冊
  name text PRIMARY KEY, surveyor text, section text, y97 double precision, x97 double precision,
  created timestamptz, case_type text, parcels text, orig_name text, geom geometry(Point, 3826)
);
CREATE TABLE kc_cowork.cases (              -- 案件（土地時間軸）
  id text PRIMARY KEY, surveyor text, case_type text, case_no text, section text, parcels text[], created timestamptz
);
RESET ROLE;

-- 5. 方便 QGIS 看的清查檢視表（原始清查表 + 平台判斷的狀態）
CREATE OR REPLACE VIEW kc_cowork.v_ctl_state AS
SELECT ptn, state,
       CASE WHEN state IN ('x','X') THEN '已回報找不到'
            WHEN state = '?' THEN '狀態未知'
            WHEN state = '1' THEN '預計作為轉換參數點'
            WHEN state = '0' THEN '有效' ELSE '未清查' END AS state_label,
       geom
FROM public.n_kc_ctl;
ALTER VIEW kc_cowork.v_ctl_state OWNER TO kc_cowork_app;

// CeX 工具的路徑單一來源。
//
// 為什麼要單獨一支：本機（D:\AI\cex-db）與雲端備援（GitHub Actions 的暫存目錄）要能跑同一批
// 腳本，只差一個環境變數。這支刻意不 import 任何重量級模組（例如 node:sqlite），
// 所以抓取端的腳本（mirror／cloud-fallback）可以安心共用，不必背資料庫依賴。
//
// 覆寫方式（由大到小）：
//   CEX_HOME         整包搬到別的目錄（雲端用這個就好）
//   CEX_DB          只換資料庫檔
//   CEX_MIRROR_DIR  只換原始鏡像落地目錄
//   CEX_LOG_DIR     只換日誌目錄
//   CEX_SNAP_DIR    只換快照目錄
import { join } from 'node:path';

export const CEX_HOME = process.env.CEX_HOME || 'D:\\AI\\cex-db';
export const DB_PATH = process.env.CEX_DB || join(CEX_HOME, 'cex.sqlite');
export const MIRROR_DIR = process.env.CEX_MIRROR_DIR || join(CEX_HOME, 'mirror');
export const LOG_DIR = process.env.CEX_LOG_DIR || join(CEX_HOME, 'logs');
export const SNAP_DIR = process.env.CEX_SNAP_DIR || join(CEX_HOME, 'snapshots');

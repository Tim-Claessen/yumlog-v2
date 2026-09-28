import { createClient } from '@supabase/supabase-js';
import { YUMLOG_DB_SCHEMA } from './db-schema';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

// db.schema routes every .from() and .rpc() to the `yumlog` schema (PostgREST
// Accept-Profile / Content-Profile headers). Auth is project-wide and unaffected.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: YUMLOG_DB_SCHEMA },
});

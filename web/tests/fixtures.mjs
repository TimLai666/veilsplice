import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
export const ownerHash=createHash('sha256').update('owner@example.test').digest('hex');
export function testDatabase(token=null, owner=ownerHash){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of ['0000_chemical_black_widow.sql','0001_lovely_thor_girl.sql'])sqlite.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 if(token!==null)sqlite.prepare('INSERT INTO service_credentials(owner_hash,service,token,updated_at,disabled_at) VALUES(?,?,?,?,NULL)').run(owner,'finmind',token,Date.now());
 const queries=[];
 return {
  sqlite, queries,
  prepare(sql) {
   queries.push(sql);
   const stmt = sqlite.prepare(sql);
   return { bind(...v) {
    return {
     async first() { return stmt.get(...v) ?? null; },
     async run() { stmt.run(...v); return {success:true}; }
    };
   }};
  }
 };
}
export const testEnvironment=(token='fixture-secret-not-a-real-key')=>({DB:testDatabase(token),OWNER_EMAIL_SHA256:ownerHash});

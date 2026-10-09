import { Client } from 'pg';

/**
 * Substitutes psql-style variables in bootstrap SQL safely:
 *   :'name'  -> quoted literal     :"name" -> quoted identifier
 * Used only for bootstrap files (role passwords, database name), which cannot
 * use bind parameters because they are DDL.
 */
export function renderSql(sql: string, vars: Record<string, string>, client: Client): string {
  return sql
    .replace(/:'([a-z_]+)'/g, (_, k: string) => {
      if (!(k in vars)) throw new Error(`Missing SQL variable ${k}`);
      return client.escapeLiteral(vars[k]);
    })
    .replace(/:"([a-z_]+)"/g, (_, k: string) => {
      if (!(k in vars)) throw new Error(`Missing SQL variable ${k}`);
      return client.escapeIdentifier(vars[k]);
    });
}

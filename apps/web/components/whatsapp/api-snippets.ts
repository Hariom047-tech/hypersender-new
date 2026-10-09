/** Code samples for the instance API tab (not UI text: skipped by the i18n scanner, like landing/code-samples.ts). */
export type Lang = 'curl' | 'node' | 'php' | 'python';

export function snippet(lang: Lang, method: string, url: string, key: string, body?: Record<string, unknown>): string {
  const json = body ? JSON.stringify(body, null, 2) : '';
  if (lang === 'curl') {
    return [`curl -X ${method} "${url}" \\`, `  -H "Authorization: Bearer ${key}"${body ? ' \\' : ''}`,
      ...(body ? ['  -H "Content-Type: application/json" \\', `  -d '${JSON.stringify(body)}'`] : [])].join('\n');
  }
  if (lang === 'node') {
    return `const res = await fetch("${url}", {\n  method: "${method}",\n  headers: {\n    Authorization: "Bearer ${key}",${body ? '\n    "Content-Type": "application/json",' : ''}\n  },${
      body ? `\n  body: JSON.stringify(${json.replace(/\n/g, '\n  ')}),` : ''}\n});\nconsole.log(await res.json());`;
  }
  if (lang === 'php') {
    return `$ch = curl_init("${url}");\ncurl_setopt_array($ch, [\n  CURLOPT_CUSTOMREQUEST => "${method}",\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ["Authorization: Bearer ${key}", "Content-Type: application/json"],${
      body ? `\n  CURLOPT_POSTFIELDS => json_encode(${phpArray(body, 1)}),` : ''}\n]);\n$response = json_decode(curl_exec($ch), true);`;
  }
  return `import requests\n\nres = requests.${method.toLowerCase()}(\n    "${url}",\n    headers={"Authorization": "Bearer ${key}"},${
    body ? `\n    json=${json.replace(/true/g, 'True').replace(/false/g, 'False').replace(/\n/g, '\n    ')},` : ''}\n)\nprint(res.json())`;
}
function phpArray(v: unknown, depth: number): string {
  if (v && typeof v === 'object') {
    const pad = '  '.repeat(depth + 1);
    return `[\n${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pad}"${k}" => ${phpArray(x, depth + 1)}`).join(',\n')}\n${'  '.repeat(depth)}]`;
  }
  return JSON.stringify(v);
}

type Token = string | number | '*';

/** 仅支持属性、数组下标与通配符；不执行 JSONPath 过滤表达式或脚本。 */
function tokens(path: string): Token[] {
  if (!path.startsWith('$') || path.length > 4096) throw new Error('JSON 规则必须以 $ 开头');
  const result: Token[] = [];
  let rest = path.slice(1);
  while (rest) {
    const property = /^\.([A-Za-z_][\w-]*)/.exec(rest);
    const index = /^\[(\d+|\*)\]/.exec(rest);
    if (property) {
      if (['__proto__', 'constructor', 'prototype'].includes(property[1])) throw new Error('JSON 规则不能读取原型属性');
      result.push(property[1]); rest = rest.slice(property[0].length);
    } else if (index) { result.push(index[1] === '*' ? '*' : Number(index[1])); rest = rest.slice(index[0].length); }
    else throw new Error('JSON 规则仅支持 $.字段、[下标] 和 [*]');
    if (result.length > 64) throw new Error('JSON 规则层级过深');
  }
  return result;
}

export function validateJsonRule(rule: string, url = false): void {
  if (rule.length > 4096) throw new Error('JSON 规则过长');
  if (rule.startsWith('$') && !rule.includes('{{')) { tokens(rule); return; }
  if (rule.startsWith('$')) throw new Error('JSON 网址应使用单一路径或字面量模板');
  if (!url || /@js:|javascript:|<\/?js>|\$\{|[\r\n]/i.test(rule)) throw new Error('JSON 字段仅支持声明式路径，不支持脚本');
  const stripped = rule.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) => { tokens(path.trim()); return ''; });
  if (/[{}]/.test(stripped)) throw new Error('JSON 网址模板格式无效');
}

export function jsonValues(value: unknown, path: string): unknown[] {
  let current = [value];
  for (const token of tokens(path)) {
    const next: unknown[] = [];
    for (const item of current) {
      if (token === '*') {
        if (Array.isArray(item)) {
          if (next.length + item.length > 20_000) throw new Error('JSON 结果超过 20,000 条');
          next.push(...item);
        }
      }
      else if (item !== null && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, token)) next.push((item as Record<string | number, unknown>)[token]);
      if (next.length > 20_000) throw new Error('JSON 结果超过 20,000 条');
    }
    current = next;
  }
  return current;
}

function scalar(value: unknown, url = false): string {
  if (url && typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('JSON 网址包含不安全整数，请以字符串返回长 ID');
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function jsonText(value: unknown, rule: string, url = false): string {
  if (url && !rule.startsWith('$')) {
    let missing = false;
    const result = rule.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) => {
      const field = scalar(jsonValues(value, path.trim())[0], true);
      if (!field) missing = true;
      return encodeURIComponent(field);
    });
    return missing ? '' : result;
  }
  return scalar(jsonValues(value, rule)[0], url);
}

import type { BookSource, BuiltinSourceSummary } from '../../shared/online';
import { normalizeSource } from './rules';

interface Builtin { summary: BuiltinSourceSummary; source: BookSource }

const gutenberg = {
  bookSourceUrl: 'https://www.gutenberg.org', enabled: true,
  ruleSearch: { bookList: 'li.booklink', name: '.title@text', author: '.subtitle@text', bookUrl: 'a.link@href' },
  ruleToc: { chapterList: 'a.read-online-button', chapterName: '@text', chapterUrl: '@href' },
  ruleContent: { content: 'body@text' },
};

const definitions = [
  {
    id: 'jingzhi-public', name: '经致文学 · 公开章节', language: '中文',
    description: '中文原创小说站，仅列出无需登录的公开章节，不包含 VIP 章节。',
    config: {
      bookSourceName: '经致文学（公开章节）', bookSourceUrl: 'https://www.jingzhi5.com', enabled: true,
      searchUrl: '/?s=search&a=index&keyword={{key}}&page={{page}}',
      ruleSearch: { bookList: '.works-list > li', name: 'a.title@text', author: '.search-info a:not(.title)@text', bookUrl: 'a.title@href' },
      ruleBookInfo: { name: 'h2@text', author: '.author-zone a.name@text', tocUrl: '.buttons a.index@href' },
      ruleToc: { chapterList: '.float-list a.name:not(.isvip)', chapterName: '@text', chapterUrl: '@href' },
      ruleContent: { content: '.page-content@text' },
    },
  },
  {
    id: 'gutenberg-zh', name: 'Project Gutenberg · 中文', language: '中文',
    description: '中文经典作品，已验证《論語》；整书作为全文条目，建议优先小型作品。',
    config: { ...gutenberg, bookSourceName: 'Project Gutenberg（中文）', searchUrl: '/ebooks/search/?query={{key}}&languages[]=zh' },
  },
  {
    id: 'gutenberg', name: 'Project Gutenberg', language: '多语言',
    description: 'Gutenberg 多语言图书目录；整书作为一个全文条目。',
    config: { ...gutenberg, bookSourceName: 'Project Gutenberg', searchUrl: '/ebooks/search/?query={{key}}' },
  },
  {
    id: 'standard-ebooks', name: 'Standard Ebooks', language: '英文',
    description: '精校英文经典作品，支持搜索、作者与整书正文。',
    config: {
      bookSourceName: 'Standard Ebooks', bookSourceUrl: 'https://standardebooks.org', enabled: true,
      searchUrl: '/ebooks?query={{key}}&sort=relevance',
      ruleSearch: { bookList: '.ebooks-list > li', name: 'p:not(.author) a@text', author: 'p.author@text', bookUrl: 'p:not(.author) a@href' },
      ruleToc: { chapterList: 'a[href$="/text/single-page"]', chapterName: '@text', chapterUrl: '@href' },
      ruleContent: { content: 'body@text' },
    },
  },
];

// 配置与用户自定义源走同一验证和解析路径；列出内置目录不会发起网络请求。
const builtins: Builtin[] = definitions.map(definition => {
  const source = normalizeSource(definition.config);
  return {
    summary: { id: definition.id, name: definition.name, description: definition.description, language: definition.language, sourceId: source.id, searchUrl: source.searchUrl },
    source,
  };
});

export function listBuiltinSources(): BuiltinSourceSummary[] { return structuredClone(builtins.map(item => item.summary)); }
export function getBuiltinSource(id: string): BookSource {
  const item = builtins.find(item => item.summary.id === id);
  if (!item) throw new Error('内置书源不存在');
  return structuredClone(item.source);
}

/**
 * 属性标签的规则库分类器：按域名与标题关键词给网站 / 文章打主题标签。
 *
 * 纯本地规则、无外部依赖——不需要调用任何 AI 服务，保存链接时同步计算，
 * 「一键识别」按钮用于补齐历史数据。要调整分类体系只改这张表即可：
 * 规则自上而下匹配，先命中先生效，因此更具体的类别放前面。
 */
export type TagRule = {
  tag: string;
  /** 域名后缀匹配：host 等于或结尾于其中任一域名（已归一 www.） */
  domains?: string[];
  /** 标题 / 网址的小写子串匹配 */
  keywords?: string[];
};

export const TAG_RULES: TagRule[] = [
  {
    tag: 'AI',
    domains: [
      'openai.com', 'chatgpt.com', 'anthropic.com', 'claude.ai', 'gemini.google.com',
      'huggingface.co', 'kimi.moonshot.cn', 'tongyi.aliyun.com', 'doubao.com',
      'yiyan.baidu.com', 'perplexity.ai', 'midjourney.com', 'stability.ai',
    ],
    keywords: ['人工智能', '大模型', '提示词', 'prompt', 'aigc'],
  },
  {
    tag: '技术社区',
    domains: [
      'github.com', 'gitlab.com', 'gitee.com', 'stackoverflow.com', 'v2ex.com',
      'juejin.cn', 'csdn.net', 'segmentfault.com', 'dev.to', 'linux.do',
      'zhihu.com', 'jianshu.com', 'medium.com', 'news.ycombinator.com',
    ],
    keywords: ['掘金', '博客园', '开发者社区'],
  },
  {
    tag: '开发工具',
    domains: [
      'npmjs.com', 'pypi.org', 'crates.io', 'cloudflare.com', 'vercel.com',
      'netlify.com', 'render.com', 'railway.app', 'docker.com', 'nginx.org',
      'sqlite.org', 'postgresql.org', 'regex101.com', 'jsonformatter.org',
    ],
    keywords: ['部署', '托管', '容器', '脚手架'],
  },
  {
    tag: '文档参考',
    domains: [
      'developer.mozilla.org', 'readthedocs.io', 'docs.github.com', 'wikipedia.org',
      'ruanyifeng.com', 'caniuse.com', 'typescriptlang.org', 'python.org',
    ],
    keywords: ['文档', '手册', '规范', 'api 参考', 'reference'],
  },
  {
    tag: '资讯新闻',
    domains: [
      'bbc.com', 'cnn.com', 'reuters.com', 'theguardian.com', '36kr.com',
      'sspai.com', 'ifanr.com', 'solidot.org', 'zaobao.com', 'ft.com',
    ],
    keywords: ['新闻', '资讯', '日报', '快讯', '周报'],
  },
  {
    tag: '社交媒体',
    domains: [
      'twitter.com', 'x.com', 'weibo.com', 'douban.com', 'reddit.com',
      'instagram.com', 'facebook.com', 'tieba.baidu.com', 'xiaohongshu.com',
    ],
    keywords: ['微博', '豆瓣', '社区', '论坛', '动态'],
  },
  {
    tag: '视频影音',
    domains: [
      'youtube.com', 'bilibili.com', 'vimeo.com', 'twitch.tv', 'nicovideo.jp',
      'iqiyi.com', 'youku.com', 'spotify.com', 'xiaoyuzhoufm.com',
    ],
    keywords: ['视频', '番剧', '直播', '播客', '电台'],
  },
  {
    tag: '设计素材',
    domains: [
      'dribbble.com', 'behance.net', 'figma.com', 'zcool.com.cn', 'huaban.com',
      'pinterest.com', 'unsplash.com', 'pexels.com', 'iconfont.cn', 'canva.com',
    ],
    keywords: ['设计', 'ui', 'ux', '灵感', '素材', '字体', '配色'],
  },
  {
    tag: '在线工具',
    domains: [
      'tool.lu', 'cli.im', 'smallpdf.com', 'tinypng.com', 'carbon.now.sh',
      'excalidraw.com', 'processon.com', 'convertio.co',
    ],
    keywords: ['工具', '转换', '计算器', '生成器', '在线', '压缩'],
  },
  {
    tag: '教程学习',
    domains: [
      'coursera.org', 'udemy.com', 'khanacademy.org', 'icourse163.org',
      'geeksforgeeks.org', 'leetcode.cn', 'luogu.com.cn', 'w3school.com.cn',
    ],
    keywords: ['教程', '课程', '学习', '入门', '指南', 'tutorial', 'learn'],
  },
  {
    tag: '购物消费',
    domains: [
      'taobao.com', 'jd.com', 'amazon.com', 'tmall.com', 'pdd.com', 'dewu.com',
    ],
    keywords: ['购物', '优惠', '折扣', '评测'],
  },
];

/** host 归一后与规则域名做后缀匹配（www. 前缀视为同一主机） */
function hostMatches(host: string, domain: string): boolean {
  const h = host.replace(/^www\./, '').toLowerCase();
  const d = domain.replace(/^www\./, '').toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * 返回属性标签；无规则命中时返回空串（未识别）。
 * 先域名后关键词：域名是强信号，标题关键词兜底个人博客等内容页。
 */
export function autoTag(host: string, title: string, url: string): string {
  const haystack = `${title} ${url}`.toLowerCase();
  for (const rule of TAG_RULES) {
    if (rule.domains?.some((d) => hostMatches(host, d))) return rule.tag;
    if (rule.keywords?.some((k) => haystack.includes(k.toLowerCase()))) return rule.tag;
  }
  return '';
}

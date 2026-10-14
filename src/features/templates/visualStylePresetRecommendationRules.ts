export type RecommendationAxis = "use_case" | "industry" | "audience" | "format" | "style";

export interface RuleTag {
  axis: RecommendationAxis;
  id: string;
  phrases: readonly string[];
}

/**
 * The controlled vocabulary shared by the deterministic fallback and the
 * one-shot LLM intent normalizer. Keeping it beside the aliases prevents a
 * prompt-only tag from silently becoming impossible to score.
 */
export const VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS: Readonly<Record<RecommendationAxis, readonly string[]>> = {
  use_case: [
    "business-review", "financial-results", "project-update", "project-weekly-update", "sales-performance-review", "fundraising", "early-stage-pitch", "investor-update", "debt-financing-proposal", "strategy", "sales-plan", "resource-prioritization", "growth-strategy", "portfolio-strategy", "cost-optimization", "technical-roadmap", "customer-success-review", "product-training", "technical-training", "market-entry", "partnership", "product-launch", "marketing-campaign", "policy-brief", "public-service", "emergency-exercise", "health-education", "clinical-case", "medical-research", "research-progress", "education-lesson", "academic-presentation", "training", "industry-analysis", "travel-guide", "culture-story",
  ],
  industry: ["business", "finance", "technology", "healthcare", "education", "public-sector", "consumer", "infrastructure", "media", "travel"],
  audience: ["executive", "investor", "client", "employee", "professional", "patient", "public", "students", "children"],
  format: ["quarterly-report", "annual-report", "status-update", "roadmap", "pitch-deck", "proposal", "lesson", "case-conference", "research-presentation", "guide", "workshop"],
  style: ["formal", "editorial", "playful", "dark", "fresh", "minimal"],
};

/**
 * Visual elements that can be explicitly rejected. This intentionally extends
 * the smaller primary-style vocabulary: a template may be formally styled yet
 * still contain a dark cover or illustration that the user has ruled out.
 */
export const VISUAL_STYLE_PRESET_RECOMMENDATION_VISUAL_TRAIT_IDS = [
  ...VISUAL_STYLE_PRESET_RECOMMENDATION_TAG_IDS.style,
  "cartoon",
  "illustration",
  "photographic",
  "data-dense",
  "high-contrast",
  "colorful",
  "muted",
] as const;

/**
 * Product-maintained aliases for deterministic template recommendation.
 * A phrase may map only to an existing canonical tag. These are full,
 * reviewable expressions — never arbitrary one- or two-character fragments.
 */
export const VISUAL_STYLE_PRESET_RECOMMENDATION_RULES: readonly RuleTag[] = [
  { axis: "use_case", id: "business-review", phrases: ["business review", "performance review", "operating review", "经营复盘", "经营分析", "业绩复盘", "业绩分析", "经营情况", "门店经营", "运营月报", "客服中心"] },
  { axis: "use_case", id: "financial-results", phrases: ["annual financial", "financial results", "financial report", "annual report", "quarterly report", "quarterly business review", "earnings report", "qbr", "revenue", "cash flow", "profit and loss", "财务", "财报", "年报", "季报", "营收", "收入", "毛利", "利润", "现金流", "损益", "年度业绩", "财务汇报"] },
  { axis: "use_case", id: "project-update", phrases: ["project update", "project status", "status update", "milestone update", "项目进展", "项目状态", "项目汇报", "里程碑", "阶段进展", "工作进展", "项目看板", "供应链改善", "科研进展"] },
  { axis: "use_case", id: "project-weekly-update", phrases: ["客户开周会", "项目周会", "下周怎么推进", "本周进展"] },
  { axis: "use_case", id: "sales-performance-review", phrases: ["销售掉得", "达成率", "重点客户流失", "销售业绩"] },
  { axis: "use_case", id: "fundraising", phrases: ["fundraising", "investment", "investor pitch", "融资", "融资计划", "融资路演", "募资", "投资人", "投资者", "路演", "a轮", "b轮", "seed", "pre seed", "创业大赛", "demo day"] },
  { axis: "use_case", id: "early-stage-pitch", phrases: ["天使投资人", "创始团队", "产品验证", "创业大赛", "demo day"] },
  { axis: "use_case", id: "investor-update", phrases: ["老股东", "潜在股东", "股东沟通", "投资方", "补充资金"] },
  { axis: "use_case", id: "debt-financing-proposal", phrases: ["商业计划书", "资金需求", "还款来源", "收益测算", "银行和产业方"] },
  { axis: "use_case", id: "strategy", phrases: ["strategy", "strategic plan", "strategic planning", "roadmap", "okr", "战略", "战略规划", "年度计划", "行动计划", "发展规划", "路线图", "推进思路", "落地安排", "优先级讨论", "增长打法", "产品线", "降本增效"] },
  { axis: "use_case", id: "sales-plan", phrases: ["销售攻坚", "销售计划", "销售目标", "销售漏斗"] },
  { axis: "use_case", id: "resource-prioritization", phrases: ["必须做", "应该做", "可以晚点做", "取舍依据", "优先级讨论"] },
  { axis: "use_case", id: "growth-strategy", phrases: ["增长打法", "第二增长曲线", "新客", "老客"] },
  { axis: "use_case", id: "portfolio-strategy", phrases: ["重新梳理产品线", "继续加码", "哪些收缩"] },
  { axis: "use_case", id: "cost-optimization", phrases: ["降本增效", "成本项", "改善机会"] },
  { axis: "use_case", id: "technical-roadmap", phrases: ["技术路线", "基础设施升级", "版本节点", "稳定性治理"] },
  { axis: "use_case", id: "customer-success-review", phrases: ["客户成功", "客户健康度", "续约", "增购"] },
  { axis: "use_case", id: "product-training", phrases: ["销售新人", "典型话术", "常见异议", "产品能力"] },
  { axis: "use_case", id: "technical-training", phrases: ["a/b test", "git和github", "git协作", "branch", "rebase"] },
  { axis: "use_case", id: "market-entry", phrases: ["market entry", "go to market", "新市场", "市场进入", "出海", "海外市场", "招商"] },
  { axis: "use_case", id: "partnership", phrases: ["partnership", "strategic partnership", "合作方案", "合作伙伴", "联合方案"] },
  { axis: "use_case", id: "product-launch", phrases: ["product launch", "new product launch", "新品上市", "产品发布", "新产品"] },
  { axis: "use_case", id: "marketing-campaign", phrases: ["marketing campaign", "brand positioning", "brand refresh", "营销活动", "营销节奏", "品牌定位", "品牌焕新", "市场活动"] },
  { axis: "use_case", id: "policy-brief", phrases: ["policy brief", "policy decision", "政策解读", "政策简报", "决策材料", "决策简报", "应急响应", "桌面推演", "城市热岛"] },
  { axis: "use_case", id: "public-service", phrases: ["public service", "community service", "公共服务", "社区服务", "城市治理", "基层治理", "养老服务", "独居老人", "垃圾分类"] },
  { axis: "use_case", id: "emergency-exercise", phrases: ["极端暴雨", "应急响应", "桌面推演", "物资调度"] },
  { axis: "use_case", id: "health-education", phrases: ["health education", "health awareness", "patient education", "健康科普", "健康宣教", "患者宣教", "疾病科普", "防病", "防跌倒", "静脉输液"] },
  { axis: "use_case", id: "clinical-case", phrases: ["case conference", "clinical case", "case study", "病例讨论", "病例复盘", "mdt", "临床病例", "急诊胸痛"] },
  { axis: "use_case", id: "medical-research", phrases: ["medical research", "journal club", "literature review", "真实世界研究", "文献会", "文献汇报", "医学研究"] },
  { axis: "use_case", id: "research-progress", phrases: ["科研进展", "实验室介绍", "模型结构", "失败的尝试"] },
  { axis: "use_case", id: "education-lesson", phrases: ["education", "lesson", "learning", "science education", "science communication", "科普", "科学发现", "教学", "课程", "课堂", "公开课", "讲座", "高中历史课"] },
  { axis: "use_case", id: "academic-presentation", phrases: ["thesis defense", "research presentation", "paper sharing", "academic conference", "毕业论文答辩", "开题答辩", "学术会议", "论文分享", "科研汇报", "博士申请"] },
  { axis: "use_case", id: "training", phrases: ["training", "onboarding", "employee training", "培训", "入职培训", "新人培训", "岗前"] },
  { axis: "use_case", id: "industry-analysis", phrases: ["industry analysis", "industry outlook", "trend analysis", "行业分析", "行业变化", "行业趋势", "趋势分享", "现状分析"] },
  { axis: "use_case", id: "travel-guide", phrases: ["travel guide", "travel itinerary", "vacation planner", "旅行攻略", "旅游攻略", "行程安排", "自驾", "景点"] },
  { axis: "use_case", id: "culture-story", phrases: ["culture story", "cultural observation", "文化观察", "文化故事", "内容分享", "短剧行业", "博物馆年轻化", "独立书店", "海洋塑料污染"] },

  { axis: "industry", id: "business", phrases: ["business", "enterprise", "company", "corporate", "企业", "公司", "商业"] },
  { axis: "industry", id: "finance", phrases: ["finance", "fintech", "financial", "金融", "投资", "银行", "保险"] },
  { axis: "industry", id: "technology", phrases: ["technology", "tech", "artificial intelligence", "ai", "saas", "software", "科技", "人工智能", "数字化", "机器人", "算法"] },
  { axis: "industry", id: "healthcare", phrases: ["healthcare", "medical", "clinical", "hospital", "pharmaceutical", "医疗", "临床", "医院", "肿瘤", "患者", "诊疗", "护理"] },
  { axis: "industry", id: "education", phrases: ["education", "school", "university", "campus", "教育", "学校", "大学", "高校", "学生", "课堂"] },
  { axis: "industry", id: "public-sector", phrases: ["public sector", "government", "municipal", "community", "政府", "公共部门", "街道", "区里", "城市", "社区"] },
  { axis: "industry", id: "consumer", phrases: ["consumer", "retail", "e-commerce", "dtc", "消费", "零售", "电商", "咖啡", "宠物", "品牌"] },
  { axis: "industry", id: "infrastructure", phrases: ["infrastructure", "manufacturing", "logistics", "energy", "新能源", "制造", "物流", "充电", "园区", "基础设施"] },
  { axis: "industry", id: "media", phrases: ["media", "entertainment", "film", "game", "podcast", "短剧", "游戏", "影视"] },
  { axis: "industry", id: "travel", phrases: ["tourism", "travel", "hotel", "restaurant", "旅游", "旅行", "酒店", "餐饮"] },

  { axis: "audience", id: "executive", phrases: ["board", "board of directors", "executive", "management", "董事会", "管理层", "高管", "领导"] },
  { axis: "audience", id: "investor", phrases: ["investor", "投资人", "投资者", "机构投资"] },
  { axis: "audience", id: "client", phrases: ["client", "customer", "客户", "甲方", "对外"] },
  { axis: "audience", id: "employee", phrases: ["employee", "staff", "team", "员工", "同事", "团队", "部门内部"] },
  { axis: "audience", id: "professional", phrases: ["professional", "practitioner", "医生", "同行医生", "医护", "专家", "专业人员"] },
  { axis: "audience", id: "patient", phrases: ["patient", "family caregiver", "患者", "家属"] },
  { axis: "audience", id: "public", phrases: ["public", "residents", "公众", "居民", "市民", "社区居民"] },
  { axis: "audience", id: "students", phrases: ["student", "university student", "college student", "大学生", "高中", "中学生", "新生"] },
  { axis: "audience", id: "children", phrases: ["children", "kids", "elementary", "小学", "儿童", "少儿", "幼小"] },

  { axis: "format", id: "quarterly-report", phrases: ["quarterly report", "quarterly business review", "季度经营", "季度复盘", "季度汇报", "qbr"] },
  { axis: "format", id: "annual-report", phrases: ["annual report", "annual review", "年度报告", "年度复盘", "年度总结", "年终"] },
  { axis: "format", id: "status-update", phrases: ["status update", "monthly update", "进展汇报", "月度汇报", "项目进展", "阶段性"] },
  { axis: "format", id: "roadmap", phrases: ["roadmap", "路线图", "行动计划", "推进计划", "时间表", "阶段安排"] },
  { axis: "format", id: "pitch-deck", phrases: ["pitch deck", "investor deck", "融资路演", "商业路演", "路演"] },
  { axis: "format", id: "proposal", phrases: ["proposal", "方案说明", "解决方案", "投标", "提案"] },
  { axis: "format", id: "lesson", phrases: ["lesson", "classroom", "课程", "课堂", "讲课", "公开课"] },
  { axis: "format", id: "case-conference", phrases: ["case conference", "病例讨论", "病例展示", "mdt"] },
  { axis: "format", id: "research-presentation", phrases: ["research presentation", "paper sharing", "thesis defense", "答辩", "学术会议", "论文", "文献会"] },
  { axis: "format", id: "guide", phrases: ["guide", "指南", "攻略", "宣教", "入门介绍"] },
  { axis: "format", id: "workshop", phrases: ["workshop", "研讨会", "工作坊"] },

  { axis: "style", id: "formal", phrases: ["formal", "executive", "professional", "正式", "严谨", "克制", "专业"] },
  { axis: "style", id: "editorial", phrases: ["editorial", "magazine", "杂志", "编辑感", "报刊"] },
  { axis: "style", id: "playful", phrases: ["playful", "comic", "cartoon", "漫画", "活泼", "趣味", "儿童友好"] },
  { axis: "style", id: "dark", phrases: ["dark", "black", "深色", "黑色"] },
  { axis: "style", id: "fresh", phrases: ["fresh", "spring", "清新", "春季"] },
  { axis: "style", id: "minimal", phrases: ["minimal", "clean", "简洁", "极简", "少字"] },
];

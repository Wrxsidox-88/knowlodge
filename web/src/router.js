import { createRouter, createWebHistory } from 'vue-router';

const views = {
  Login: () => import('./views/Login.vue'),
  Dashboard: () => import('./views/Dashboard.vue'),
  QAHub: () => import('./views/QAHub.vue'),
  Materials: () => import('./views/Materials.vue'),
  Analysis: () => import('./views/Analysis.vue'),
  Settings: () => import('./views/Settings.vue'),
  Exams: () => import('./views/Exams.vue'),
  WrongBook: () => import('./views/WrongBook.vue'),
  Study: () => import('./views/Study.vue'),
  Practice: () => import('./views/Practice.vue'),
  Report: () => import('./views/Report.vue'),
  Lists: () => import('./views/Lists.vue'),
  MindMap: () => import('./views/MindMap.vue')
};

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: views.Login, meta: { public: true } },
    { path: '/', component: views.Dashboard, meta: { title: '总览' } },
    { path: '/qa', component: views.QAHub, meta: { title: 'AI 问答' } },
    { path: '/semantic', redirect: (to) => ({ path: '/qa', query: { ...to.query, tab: 'semantic' } }) },
    { path: '/graph', redirect: (to) => ({ path: '/qa', query: { ...to.query, tab: 'graph' } }) },
    { path: '/lists', component: views.Lists, meta: { title: '知识清单' } },
    { path: '/mindmap', component: views.MindMap, meta: { title: '脑图' } },
    { path: '/materials', component: views.Materials, meta: { title: '材料管理' } },
    { path: '/analysis', component: views.Analysis, meta: { title: '材料分析生成' } },
    { path: '/exams', component: views.Exams, meta: { title: '考试管理' } },
    { path: '/wrong', component: views.WrongBook, meta: { title: '错题本' } },
    { path: '/study', component: views.Study, meta: { title: '学情分析' } },
    { path: '/practice', component: views.Practice, meta: { title: '练习中心' } },
    { path: '/report', component: views.Report, meta: { title: '学习报告' } },
    { path: '/settings', component: views.Settings, meta: { title: '系统设置' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
});

router.beforeEach((to) => {
  const token = localStorage.getItem('kl_token');
  if (!to.meta.public && !token) return '/login';
  if (to.path === '/login' && token) return '/';
  return true;
});

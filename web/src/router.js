import { createRouter, createWebHistory } from 'vue-router';

const views = {
  Login: () => import('./views/Login.vue'),
  Dashboard: () => import('./views/Dashboard.vue'),
  QAHub: () => import('./views/QAHub.vue'),
  MaterialsHub: () => import('./views/MaterialsHub.vue'),
  StudyHub: () => import('./views/StudyHub.vue'),
  Settings: () => import('./views/Settings.vue')
};

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: views.Login, meta: { public: true } },
    { path: '/', component: views.Dashboard, meta: { title: '总览' } },
    { path: '/qa', component: views.QAHub, meta: { title: '知识库' } },
    { path: '/semantic', redirect: (to) => ({ path: '/qa', query: { ...to.query, tab: 'semantic' } }) },
    { path: '/graph', redirect: (to) => ({ path: '/qa', query: { ...to.query, tab: 'graph' } }) },
    { path: '/lists', redirect: (to) => ({ path: '/qa', query: { ...to.query, tab: 'lists' } }) },
    { path: '/mindmap', redirect: (to) => ({ path: '/qa', query: { ...to.query, tab: 'mindmap' } }) },
    { path: '/materials', component: views.MaterialsHub, meta: { title: '材料' } },
    { path: '/analysis', redirect: (to) => ({ path: '/materials', query: { ...to.query, tab: 'analysis' } }) },
    { path: '/studyhub', component: views.StudyHub, meta: { title: '学情中心' } },
    { path: '/exams', redirect: (to) => ({ path: '/studyhub', query: { ...to.query, tab: 'exams' } }) },
    { path: '/wrong', redirect: (to) => ({ path: '/studyhub', query: { ...to.query, tab: 'wrong' } }) },
    { path: '/study', redirect: (to) => ({ path: '/studyhub', query: { ...to.query, tab: 'study' } }) },
    { path: '/practice', redirect: (to) => ({ path: '/studyhub', query: { ...to.query, tab: 'practice' } }) },
    { path: '/report', redirect: (to) => ({ path: '/studyhub', query: { ...to.query, tab: 'report' } }) },
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

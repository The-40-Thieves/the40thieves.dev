// Lighthouse CI: serves the built hub from disk, runs each page five times, and fails on any
// category whose median run scores under 0.95 (P2-06 acceptance). Results land in
// .lighthouseci (git-ignored).
const categories = ['performance', 'accessibility', 'best-practices', 'seo'];

module.exports = {
  ci: {
    collect: {
      staticDistDir: 'apps/hub/dist/client',
      // The origin is replaced by the local static server; these are the P2-06 budget pages and the P4-S4 try app (its island hydrated on load).
      url: ['http://localhost/', 'http://localhost/codecalc/', 'http://localhost/alexandria/try/'],
      numberOfRuns: 5,
      settings: {
        preset: 'desktop',
      },
    },
    assert: {
      assertions: Object.fromEntries(
        categories.map((name) => [
          `categories:${name}`,
          ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        ]),
      ),
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci',
    },
  },
};

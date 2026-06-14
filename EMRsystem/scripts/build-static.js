const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDirs = [
  { dir: path.resolve(root, 'dist'), clean: true },
  { dir: path.resolve(root, '..', 'VercelFrontend'), clean: false },
];
const staticFiles = [
  'admin-dashboard.html',
  'admin.html',
  'api-config.js',
  'assessment.html',
  'dashboard.html',
  'doctor-dashboard.html',
  'doctor-login.html',
  'doctor-register.html',
  'index.html',
  'login.html',
  'password-toggle.js',
  'qrcode.min.js',
  'register.html',
  'simple-login.html',
  'staff-login.html',
  'staff-register.html',
  'staff.html',
  'styles.css',
];

const staticVercelConfig = {
  version: 2,
  builds: [
    {
      src: '**/*',
      use: '@vercel/static',
    },
  ],
  cleanUrls: true,
  routes: [
    {
      src: '/',
      dest: '/index.html',
    },
    {
      src: '/(.*)',
      headers: {
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
      continue: true,
    },
  ],
};

for (const { dir: outDir, clean } of outDirs) {
  if (clean) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const file of staticFiles) {
    fs.copyFileSync(path.join(root, file), path.join(outDir, file));
  }

  fs.copyFileSync(path.join(root, 'app.js'), path.join(outDir, 'auth-client.js'));

  fs.writeFileSync(
    path.join(outDir, 'vercel.json'),
    `${JSON.stringify(staticVercelConfig, null, 2)}\n`
  );

  console.log(`Copied ${staticFiles.length} static files to ${outDir}`);
}

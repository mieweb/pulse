// @ts-check
/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Pulse Cam Developer Docs",
  tagline: "Integrate secure video capture and upload into your application",
  favicon: "img/favicon.ico",

  url: "https://mieweb.github.io",
  baseUrl: "/pulse/",

  organizationName: "mieweb",
  projectName: "pulse",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.js",
          editUrl: "https://github.com/mieweb/pulse/tree/main/docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: "Pulse Cam",
        items: [
          {
            type: "docSidebar",
            sidebarId: "docs",
            position: "left",
            label: "Docs",
          },
          {
            href: "https://github.com/mieweb/pulse",
            label: "GitHub",
            position: "right",
          },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [
              { label: "Getting Started", to: "/" },
              { label: "Launching Pulse Cam", to: "/launching" },
              { label: "Troubleshooting", to: "/troubleshooting" },
              { label: "Handling Uploads", to: "/uploads/" },
            ],
          },
          {
            title: "More",
            items: [
              { label: "GitHub", href: "https://github.com/mieweb/pulse" },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Medical Informatics Engineering, Inc.`,
      },
      prism: {
        theme: require("prism-react-renderer").themes.github,
        darkTheme: require("prism-react-renderer").themes.dracula,
        additionalLanguages: ["bash", "json"],
      },
    }),
};

module.exports = config;

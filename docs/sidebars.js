/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    "intro",
    "launching",
    {
      type: "category",
      label: "Handling Uploads",
      link: { type: "doc", id: "uploads/index" },
      items: [
        "uploads/pulsevault",
        "uploads/tus",
        "uploads/chunked",
      ],
    },
    {
      type: "category",
      label: "Framework Guides",
      items: [
        "frameworks/javascript",
        "frameworks/react-mieweb-ui",
      ],
    },
  ],
};

module.exports = sidebars;

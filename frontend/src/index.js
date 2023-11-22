import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "@myst-theme/providers";
import { MyST, DEFAULT_RENDERERS } from "myst-to-react";

import { fromMarkdown } from "mdast-util-from-markdown";

const Param = ({ node }) => {
  return <>
    <dt>
      {node.param}: {node.type_}
    </dt>
    <dd>
      {node.desc.map((sub) => (
        <MyST ast={sub} />
      ))}
    </dd>
  </>;
};
const Parameters = ({ node }) => {
  return (
    <dl>
      {node.children.map((item) => (
        <MyST ast={item} />
      ))}
    </dl>
  );
};

const DefList = ({ node }) => {
  return (
    <dl>
      {node.children.map((item) => (
        <>
          <dt>
            <MyST ast={item.dt} />
          </dt>
          <dd>
            {item.dd.map((sub) => (
              <MyST ast={sub} />
            ))}
          </dd>
        </>
      ))}
    </dl>
  );
};

const SignatureRenderer = ({ node }) => {
  return (
    <>
      <div className="flex my-5 group">
        <div className="flex-grow overflow-x-auto overflow-y-hidden" />
        {node.value}
      </div>
      <div>
        <MyST ast={node.children} />
      </div>
    </>
  );
};

const Directive = ({ node }) => {
  const dom = node.domain !== null ? ":"+node.domain : ""
  const role = node.role !== null ? ":"+node.role+":" : ""
  return (
    <>
      <code className="not-implemented">
        <span>{dom}{role}`{node.value}`</span>
      </code>
    </>
  );
};

const LOC = {
  signature: SignatureRenderer,
  Directive: Directive,
  DefList: DefList,
  Parameters: Parameters,
  Param: Param,
};
const RENDERERS = { ...DEFAULT_RENDERERS, ...LOC };

function MyComponent({ node }) {
  console.log("Node", node);
  return <MyST ast={node.children} />;
}

const tree = fromMarkdown("Some *emphasis*, **strong**, and `code`.");
const mytree = {
  type: "admonition",
  children: [
    { type: "text", value: "myValue" },
    {
      type: "signature",
      value: "Foo",
      children: [{ type: "text", value: "Child" }],
    },
  ],
};

console.log("Loading X");

const render = (id, tree) => {
  const root = ReactDOM.createRoot(document.getElementById(id));

  root.render(
    <React.StrictMode>
      <ThemeProvider renderers={RENDERERS}>
        <MyComponent node={tree} />
      </ThemeProvider>
    </React.StrictMode>
  );
};

window.render = render;
window.fromMarkdown = fromMarkdown;

declare module 'react-syntax-highlighter' {
  import * as React from 'react';
  export const Prism: React.ComponentType<any>;
  export const Light: React.ComponentType<any>;
  export default class SyntaxHighlighter extends React.Component<any> {}
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  export const oneDark: any;
  export const oneLight: any;
  export const vscDarkPlus: any;
  export const vs: any;
}

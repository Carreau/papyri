(self.webpackChunkpapyri_frontend=self.webpackChunkpapyri_frontend||[]).push([[3494],{1290:function(e){function n(){for(var e=arguments.length,n=new Array(e),a=0;a<e;a++)n[a]=arguments[a];return n.map((function(e){return(n=e)?"string"===typeof n?n:n.source:null;var n})).join("")}e.exports=function(e){var a={ruleDeclaration:/^[a-zA-Z][a-zA-Z0-9-]*/,unexpectedChars:/[!@#$^&',?+~`|:]/},r=e.COMMENT(/;/,/$/),s={className:"attribute",begin:n(a.ruleDeclaration,/(?=\s*=)/)};return{name:"Augmented Backus-Naur Form",illegal:a.unexpectedChars,keywords:["ALPHA","BIT","CHAR","CR","CRLF","CTL","DIGIT","DQUOTE","HEXDIG","HTAB","LF","LWSP","OCTET","SP","VCHAR","WSP"],contains:[s,r,{className:"symbol",begin:/%b[0-1]+(-[0-1]+|(\.[0-1]+)+){0,1}/},{className:"symbol",begin:/%d[0-9]+(-[0-9]+|(\.[0-9]+)+){0,1}/},{className:"symbol",begin:/%x[0-9A-F]+(-[0-9A-F]+|(\.[0-9A-F]+)+){0,1}/},{className:"symbol",begin:/%[si]/},e.QUOTE_STRING_MODE,e.NUMBER_MODE]}}}}]);
//# sourceMappingURL=react-syntax-highlighter_languages_highlight_abnf.017aca69.chunk.js.map
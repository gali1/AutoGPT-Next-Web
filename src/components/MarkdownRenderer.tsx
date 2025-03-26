import React, { useCallback, useState, useEffect } from "react";
import { FaCopy } from "react-icons/fa";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/default.css";

const MarkdownRenderer = ({ children }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeHighlight]}
    components={{
      pre: CustomPre,
      code: CustomCodeBlock,
      a: (props) => CustomLink({ children: props.children, href: props.href }),
      p: (props) => <p className="mb-4">{props.children}</p>,
      ul: (props) => <ul className="ml-8 list-disc">{props.children}</ul>,
      ol: (props) => <ol className="ml-8 list-decimal">{props.children}</ol>,
    }}
  >
    {children}
  </ReactMarkdown>
);

const CustomPre = ({ children }: { children: ReactNode }) => {
  const [isCopied, setIsCopied] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Set isClient to true when component mounts in the browser
  useEffect(() => {
    setIsClient(true);
  }, []);

  const code = React.Children.toArray(children).find(isValidCustomCodeBlock);

  const language: string =
    code && code.props.className
      ? extractLanguageName(code.props.className.replace("hljs ", ""))
      : "";

  const handleCopyClick = useCallback(() => {
    if (code && React.isValidElement(code) && isClient) {
      const codeString = extractTextFromNode(code.props.children);

      // Check if navigator.clipboard is available
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(codeString).catch(err => {
          console.error('Failed to copy text: ', err);
        });
      } else {
        // Fallback copy method
        const textArea = document.createElement('textarea');
        textArea.value = codeString;
        textArea.style.position = 'fixed';  // Avoid scrolling to bottom
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
          document.execCommand('copy');
        } catch (err) {
          console.error('Fallback: Failed to copy text: ', err);
        }

        document.body.removeChild(textArea);
      }

      setIsCopied(true);
      setTimeout(() => {
        setIsCopied(false);
      }, 2000);
    }
  }, [code, isClient]);

  // Only render the copy button on the client
  const copyButton = isClient ? (
    <button
      onClick={handleCopyClick}
      className="flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-600 focus:outline-none"
    >
      <FaCopy />
      {isCopied ? "Copied!" : "Copy Code"}
    </button>
  ) : null;

  return (
    <div className="mb-4 flex flex-col ">
      <div className="flex w-full items-center justify-between rounded-t-lg bg-zinc-800 p-1 px-4 text-white">
        <div>{language.charAt(0).toUpperCase() + language.slice(1)}</div>
        {copyButton}
      </div>
      <pre className="rounded-t-[0]">{children}</pre>
    </div>
  );
};

interface CustomCodeBlockProps {
  inline?: boolean;
  className?: string;
  children: ReactNode;
}

const CustomCodeBlock = ({
  inline,
  className,
  children,
}: CustomCodeBlockProps) => {
  // Inline code blocks will be placed directly within a paragraph
  if (inline) {
    return (
      <code className="rounded bg-gray-200 px-1 py-[1px] text-black">
        {children}
      </code>
    );
  }

  const language = className ? className.replace("language-", "") : "plaintext";

  return <code className={`hljs ${language}`}>{children}</code>;
};

const CustomLink = ({ children, href }) => {
  return (
    <a
      className="link overflow-hidden"
      href={href as string}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
};

const isValidCustomCodeBlock = (
  element: ReactNode
): element is React.ReactElement<CustomCodeBlockProps> =>
  React.isValidElement(element) && element.type === CustomCodeBlock;

const extractLanguageName = (languageString: string): string => {
  // The provided language will be "language-{PROGRAMMING_LANGUAGE}"
  const parts = languageString.split("-");
  if (parts.length > 1) {
    return parts[1] || "";
  }
  return "";
};

const extractTextFromNode = (node: React.ReactNode): string => {
  if (typeof node === "string") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map(extractTextFromNode).join("");
  }

  if (React.isValidElement(node)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-member-access
    return extractTextFromNode(node.props.children);
  }

  return "";
};

export default MarkdownRenderer;
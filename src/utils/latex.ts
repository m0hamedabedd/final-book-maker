// ─── LaTeX template generators ───

export function generateMainTex(opts: {
  title: string;
  subtitle: string;
  author: string;
  isArabic: boolean;
  chapterCount: number;
}): string {
  const { title, subtitle, author, isArabic, chapterCount } = opts;

  const chapterIncludes = Array.from(
    { length: chapterCount },
    (_, i) => `\\include{chapters/chapter${i + 1}}`
  ).join("\n");

  if (isArabic) {
    return generateArabicMainTex(title, subtitle, author, chapterIncludes);
  }
  return generateEnglishMainTex(title, subtitle, author, chapterIncludes);
}

function generateEnglishMainTex(
  title: string,
  subtitle: string,
  author: string,
  chapterIncludes: string
): string {
  // Escape LaTeX special chars in user input
  const t = escapeLatex(title);
  const s = escapeLatex(subtitle);
  const a = escapeLatex(author);

  return `\\documentclass[11pt, twoside, openright]{book}

% --- ENCODING & LANGUAGE ---
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[english]{babel}

% --- BOOK SIZE & MARGINS (6x9 inches - Standard Trade Paperback) ---
\\usepackage[paperwidth=6in, paperheight=9in, 
            inner=0.875in, outer=0.625in, 
            top=0.75in, bottom=0.75in]{geometry}

% --- TYPOGRAPHY & FONTS ---
\\usepackage{microtype} % Perfects text alignment and spacing
\\usepackage{ebgaramond} % A beautiful, classic font for the main text
\\usepackage{tgheros} % A clean sans-serif font (like Helvetica) for headings
\\linespread{1.15} % Slightly increases line spacing for easy reading

% --- CHAPTER HEADING STYLE (Minimalist & Modern) ---
\\usepackage{titlesec}
\\titleformat{\\chapter}[display]
  {\\sffamily\\raggedright} % Sans-serif font, left-aligned
  {\\large\\bfseries\\MakeUppercase{\\chaptertitlename} \\thechapter} % "CHAPTER 1" in small bold
  {1ex} % Space between "CHAPTER 1" and the title
  {\\Huge\\bfseries} % The title in huge, bold letters
  [\\vspace{3ex}] % White space after the title

% --- HEADER & FOOTER STYLE (Clean, no lines) ---
\\usepackage{fancyhdr}
\\pagestyle{fancy}
\\fancyhf{} % Clear default headers
% Left Even pages: Page number on far left, Book Title next to it
\\fancyhead[LE]{\\small\\sffamily \\thepage \\hspace{1.5em} \\MakeUppercase{${t}}} 
% Right Odd pages: Chapter title next to Page number on far right
\\fancyhead[RO]{\\small\\sffamily \\MakeUppercase{\\leftmark} \\hspace{1.5em} \\thepage}
\\renewcommand{\\headrulewidth}{0pt} % Removes the ugly line under the header
\\renewcommand{\\chaptermark}[1]{\\markboth{#1}{}} % Cleans up chapter name in header

% --- QUOTES & FORMATTING ---
\\usepackage{epigraph} % For quotes at the beginning of chapters
\\setlength{\\epigraphwidth}{0.8\\textwidth}
\\renewcommand{\\epigraphrule}{0pt} % Removes line between quote and author
\\renewcommand{\\epigraphflush}{flushright}

\\usepackage{lettrine} % For the large starting letter (drop cap)
\\setcounter{tocdepth}{0} % Only show chapters in the Table of Contents (keeps it clean)

% --- TABLE OF CONTENTS & LINKS ---
\\usepackage[hidelinks]{hyperref} 

% ==========================================
%            DOCUMENT STARTS HERE
% ==========================================
\\begin{document}

% --- FRONT MATTER ---
\\frontmatter

% Half-Title Page (Just the title, very clean)
\\begin{titlepage}
    \\vspace*{2in}
    \\begin{center}
        {\\sffamily\\Huge \\bfseries ${t}\\par}
    \\end{center}
\\end{titlepage}

% Full Title Page
\\newpage
\\begin{titlepage}
    \\vspace*{1.5in}
    \\begin{center}
        {\\sffamily\\Huge \\bfseries ${t}\\par}
        \\vspace{0.5in}
        {\\sffamily\\Large \\textit{${s}}\\par}
        \\vspace{2in}
        {\\sffamily\\Large ${a}\\par}
    \\end{center}
\\end{titlepage}

% Copyright Page
\\newpage
\\thispagestyle{empty}
\\vspace*{\\fill}
\\noindent \\textbf{Copyright \\copyright \\the\\year{} by ${a}}\\\\
All rights reserved.\\\\\\\\
No part of this book may be reproduced, stored in a retrieval system, or transmitted in any form or by any means, electronic, mechanical, photocopying, recording, or otherwise, without express written permission of the author.
\\vspace{2ex}

% Dedication Page (Optional)
\\newpage
\\thispagestyle{empty}
\\vspace*{2in}
\\begin{center}
    \\textit{For those who seek knowledge.}
\\end{center}

% Table of Contents
\\cleardoublepage
\\renewcommand{\\contentsname}{\\sffamily\\bfseries CONTENTS} % Modern TOC title
\\tableofcontents

% --- MAIN MATTER (The Chapters) ---
\\mainmatter

% We use \\include to bring in your chapters cleanly
${chapterIncludes}

\\end{document}
`;
}

function generateArabicMainTex(
  title: string,
  subtitle: string,
  author: string,
  chapterIncludes: string
): string {
  // For Arabic we don't escape the same way – Arabic doesn't have LaTeX specials typically
  const t = escapeLatex(title);
  const s = escapeLatex(subtitle);
  const a = escapeLatex(author);

  return `% --- IMPORTANT: YOU MUST COMPILE THIS WITH XeLaTeX ---
\\documentclass[11pt, twoside, openright]{book}

% --- BOOK SIZE & MARGINS (6x9 inches - Standard Trade Paperback) ---
\\usepackage[paperwidth=6in, paperheight=9in, 
            inner=0.875in, outer=0.625in, 
            top=0.75in, bottom=0.75in]{geometry}

% --- CHAPTER HEADING STYLE (Modern & Clean) ---
\\usepackage{titlesec}
\\titleformat{\\chapter}[display]
  {\\bfseries\\raggedright} % Right-aligned in RTL
  {\\Large الفصل \\thechapter} % "Chapter 1" (الفصل ١)
  {1ex} % Space
  {\\Huge\\bfseries} % The title in huge, bold letters
  [\\vspace{3ex}]

% --- HEADER & FOOTER STYLE ---
\\usepackage{fancyhdr}
\\pagestyle{fancy}
\\fancyhf{} % Clear default headers
\\fancyhead[RO,LE]{\\small \\thepage} % Pages on outer edges
\\fancyhead[RE]{\\small ${t}} % Book title on inner even pages
\\fancyhead[LO]{\\small \\leftmark}    % Chapter title on inner odd pages
\\renewcommand{\\headrulewidth}{0pt} % Removes the line under the header
\\renewcommand{\\chaptermark}[1]{\\markboth{#1}{}}

% --- LINKS (Must be loaded before Polyglossia for Arabic) ---
\\usepackage[hidelinks]{hyperref}

% --- ARABIC LANGUAGE & FONT SETUP (Polyglossia & Bidi) ---
\\usepackage{polyglossia}
\\setmainlanguage[numerals=maghrib]{arabic} % maghrib = 1,2,3... If you want ١,٢,٣ use 'mashriq'
\\setotherlanguage{english}

% Set the Arabic font to Amiri (beautiful classic book font)
\\newfontfamily\\arabicfont[Script=Arabic]{Amiri}
\\newfontfamily\\arabicfontsf[Script=Arabic]{Amiri} % Fallback for sans-serif

% Line spacing (Arabic needs slightly more space to look nice)
\\linespread{1.3} 

% ==========================================
%            DOCUMENT STARTS HERE
% ==========================================
\\begin{document}

% --- FRONT MATTER ---
\\frontmatter

% Half-Title Page
\\begin{titlepage}
    \\vspace*{2in}
    \\begin{center}
        {\\Huge \\bfseries ${t}\\par}
    \\end{center}
\\end{titlepage}

% Full Title Page
\\newpage
\\begin{titlepage}
    \\vspace*{1.5in}
    \\begin{center}
        {\\Huge \\bfseries ${t}\\par}
        \\vspace{0.5in}
        {\\Large \\textit{${s}}\\par}
        \\vspace{2in}
        {\\Large ${a}\\par}
    \\end{center}
\\end{titlepage}

% Copyright Page
\\newpage
\\thispagestyle{empty}
\\vspace*{\\fill}
\\noindent \\textbf{حقوق النشر \\copyright{} \\the\\year{} بقلم ${a}}\\\\
جميع الحقوق محفوظة.\\\\\\\\
لا يجوز إعادة إنتاج أي جزء من هذا الكتاب، أو تخزينه في نظام استرجاع، أو نقله بأي شكل أو بأي وسيلة، إلكترونية أو ميكانيكية أو تصويرية أو تسجيلية أو غير ذلك، دون إذن كتابي صريح من المؤلف.
\\vspace{2ex}

% Dedication Page
\\newpage
\\thispagestyle{empty}
\\vspace*{2in}
\\begin{center}
    \\textit{إلى كل طالب علم.}
\\end{center}

% Table of Contents
\\cleardoublepage
\\renewcommand{\\contentsname}{\\bfseries المحتويات}
\\tableofcontents

% --- MAIN MATTER (The Chapters) ---
\\mainmatter

% We use \\include to bring in your chapters cleanly
${chapterIncludes}

\\end{document}
`;
}

function escapeLatex(text: string): string {
  // Escape common LaTeX special characters in user-provided text
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/%/g, "\\%")
    .replace(/&/g, "\\&")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

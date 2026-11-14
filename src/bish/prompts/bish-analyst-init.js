export default () => `# Initial Specification

You are doing a single pass requirements capture process, for a new software delivery objective, which you will find described in the local README.md file.

The files \`.bish-bash-bosh/specification.md\` and \`.bish-bash-bosh/interview.md\` were just created and now it's up to you to do the following steps .

1. Prepend a top level heading \`# Objective\` to the very top of \`.bish-bash-bosh/specification.md\`, followed by one paragraph summarising the user's broad objective from the local README.md. Later steps of the harness read it for context.

2. Update \`.bish-bash-bosh/specification.md\`, using it's defined format, with a set of baseline specification items required to cover all the requirments described in the local README.md

3. Assess any gaps in the specification that would be required to complete a specification to meet the full intent of the objective from the README.md. Think critically and apply healthy back-pressure: where the README departs from general best practice include a question proposing the best-practice approach as its default; and where one stated requirement makes another hard to meet (for example inline-only delivery versus unit-testing every function) include a question that proposes a practical alternative.

4. Compose the questions, with appropriate default answers, required to fill the assessment of gaps into \`.bish-bash-bosh/interview.md\` using it's defined format.

## Working with the files

Edit \`.bish-bash-bosh/specification.md\` and \`.bish-bash-bosh/interview.md\` directly, using your normal file read/edit tools. You may read the local README.md for the objective but edit only those two files; use no skills and no searching. Their entire format is the numbered checklist lines already in each file.

## PRIME DIRECTIVE 

Do not conflate the workings of -bish-bash-bosh with the specified requirements from the user. For example -bish-bash-bosh uses it's own testing harness and tests inside the .bish-bash-bosh folder to verify it's effectiveness but if the user specifies tests as a requirment then they would be an independent set of tests in the users actual project space. Remember -bish-bash-bosh is a software delvelopment tool, the means to the end, and in no way forms part of the user's specified requirments. 

## SPECIAL CONSIDERATIONS

In determining specific questions to ask, consider these broad areas of concern and how they apply specifically to the users objective as each question and answer is prepared and as each specification item is captured.

- STRATEGY
- ARCHTECTURE
- PRODUCT METRICS
- BUILD AND CONTINUOUS DELIVERY
- DEPLOYMENT
- SECURITY AND VULNERABILITIES
- QUALITY AND TESTING
- OPERATIONS AND OBSERVABILITY
- REGULATORY AND INDUSTRY COMPLIANCE
- PERFORMANCE
- CHANGE MANAGEMENT
- COST MANAGEMENT
- SCALABILITY AND AVAILABILITY
- RISK MANAGEMENT
- USER EXPERIENCE (UX) AND DESIGN
- DATA MANAGEMENT
- LEGAL AND CONTRACTUAL CONSIDERATIONS
- TECHNOLOGY AND TOOLS
- ENVIRONMENT AND SUSTAINABILITY
- BUSINESS VALUE
- ETHICAL CONSIDERATIONS
`;

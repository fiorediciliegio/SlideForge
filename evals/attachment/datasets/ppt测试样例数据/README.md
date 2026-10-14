# Sample Project

A clean, modern starter template for your next project.

## Features

- ⚡ **Fast** — built with performance in mind
- 🎨 **Beautiful** — thoughtfully designed UI
- 📦 **Tiny** — minimal dependencies
- 🔧 **Configurable** — easy to customize

## Installation

\`\`\`bash
npm install
npm run dev
\`\`\`

## Usage

Import the main module and start using it:

\`\`\`javascript
import { create } from 'sample-project';

const app = create({
    name: 'My App',
    debug: true
});

app.start();
\`\`\`

## Configuration

| Option   | Type      | Default | Description           |
|----------|-----------|---------|-----------------------|
| name     | string    | ''      | Application name      |
| debug    | boolean   | false   | Enable debug logging  |
| port     | number    | 3000    | Server port           |

## Contributing

Pull requests are welcome! For major changes, please open an issue first.

## License

MIT © 2025
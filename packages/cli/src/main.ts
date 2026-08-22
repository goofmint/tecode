import pkg from "../package.json";

function main(argv: string[]): void {
  if (argv.includes("--version")) {
    console.log(pkg.version);
    process.exit(0);
  }
}

main(process.argv.slice(2));
